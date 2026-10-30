// Shared by the worker and the API. Never return cookie or storage values.
const { z } = require('zod');
const cookieSchema = z.object({
  name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number().finite(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
  partitionKey: z.string().optional(), _crHasCrossSiteAncestor: z.boolean().optional(),
}).strict();
const keyPath = { keyPath: z.string().optional(), keyPathArray: z.array(z.string()).optional() };
const databaseSchema = z.object({ name: z.string(), version: z.number().int().positive(), stores: z.array(z.object({
  name: z.string(), autoIncrement: z.boolean(), ...keyPath,
  indexes: z.array(z.object({ name: z.string(), ...keyPath, multiEntry: z.boolean(), unique: z.boolean() }).strict()),
  records: z.array(z.object({ key: z.unknown().optional(), keyEncoded: z.unknown().optional(), value: z.unknown().optional(), valueEncoded: z.unknown().optional() }).strict()
    // Inline-key stores derive their keys from the value and export no key field.
    .refine(record => record.value !== undefined || record.valueEncoded !== undefined)),
}).strict()) }).strict();
const storageStateSchema = z.object({ cookies: z.array(cookieSchema).max(10_000), origins: z.array(z.object({
  origin: z.string().url(), localStorage: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
  indexedDB: z.array(databaseSchema).optional(),
}).strict()) });
const cookieActive = (cookie, now) => cookie.expires === -1 || cookie.expires > now / 1000;
const cookieKey = cookie => JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey ?? '', cookie._crHasCrossSiteAncestor ?? false]);
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
// Playwright may export the same IndexedDB value as valueEncoded on one run and
// plain value on the next. Compare decoded data, including types and references.
const arrayKinds = { i8: Int8Array, ui8: Uint8Array, ui8c: Uint8ClampedArray, i16: Int16Array, ui16: Uint16Array,
  i32: Int32Array, ui32: Uint32Array, f32: Float32Array, f64: Float64Array, bi64: BigInt64Array, bui64: BigUint64Array };
function decodeStorageValue(value, refs = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if ('ref' in value) {
    if (!refs.has(value.ref)) throw new Error('Invalid storage reference');
    return refs.get(value.ref);
  }
  if ('v' in value) {
    const literals = { undefined: undefined, null: null, NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
    if (!Object.hasOwn(literals, value.v)) throw new Error('Invalid storage value');
    return literals[value.v];
  }
  if ('d' in value) return new Date(value.d);
  if ('u' in value) return new URL(value.u);
  if ('bi' in value) return BigInt(value.bi);
  if ('r' in value) return new RegExp(value.r.p, value.r.f);
  if ('e' in value) { const error = new Error(value.e.m); error.name = value.e.n; error.stack = value.e.s; return error; }
  if ('ta' in value || 'ab' in value) {
    const bytes = Uint8Array.from(Buffer.from((value.ta ?? value.ab).b, 'base64'));
    if ('ab' in value) return bytes.buffer;
    const constructor = arrayKinds[value.ta.k];
    if (!constructor) throw new Error('Invalid storage array type');
    return new constructor(bytes.buffer);
  }
  if ('a' in value || 'o' in value) {
    const result = 'a' in value ? [] : Object.create(null); refs.set(value.id, result);
    if ('a' in value) for (const item of value.a) result.push(decodeStorageValue(item, refs));
    else for (const { k, v } of value.o) result[k] = decodeStorageValue(v, refs);
    return result;
  }
  throw new Error('Unsupported storage encoding');
}
function dataSignature(value, refs = new Map()) {
  const type = typeof value;
  if (value === null) return ['null'];
  if (type === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (type !== 'object') return [type, type === 'bigint' ? String(value) : value];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (value instanceof URL) return ['url', value.href];
  if (value instanceof RegExp) return ['regexp', value.source, value.flags];
  if (value instanceof Error) return ['error', value.name, value.message, value.stack];
  if (value instanceof ArrayBuffer) return ['buffer', Buffer.from(value).toString('base64')];
  if (ArrayBuffer.isView(value)) return ['typedArray', value.constructor.name, Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
  if (refs.has(value)) return ['ref', refs.get(value)];
  const id = refs.size; refs.set(value, id);
  return Array.isArray(value) ? ['array', id, value.map(item => dataSignature(item, refs))]
    : ['object', id, Object.keys(value).sort().map(key => [key, dataSignature(value[key], refs)])];
}
function recordSignature(record) {
  try {
    const key = Object.hasOwn(record, 'keyEncoded') ? decodeStorageValue(record.keyEncoded) : record.key;
    const value = Object.hasOwn(record, 'valueEncoded') ? decodeStorageValue(record.valueEncoded) : record.value;
    return JSON.stringify([dataSignature(key), dataSignature(value)]);
  } catch { return null; }
}
function sessionSummary(state, now = Date.now()) {
  const cookies = state.cookies ?? [];
  const origins = state.origins ?? [];
  const activeCookiesCount = cookies.filter(cookie => cookieActive(cookie, now)).length;
  let localStorageEntriesCount = 0, indexedDBDatabasesCount = 0, indexedDBStoresCount = 0, indexedDBRecordsCount = 0;
  for (const origin of origins) {
    localStorageEntriesCount += origin.localStorage.length;
    for (const database of origin.indexedDB ?? []) {
      indexedDBDatabasesCount++;
      indexedDBStoresCount += database.stores.length;
      for (const store of database.stores) indexedDBRecordsCount += store.records.length;
    }
  }
  return { cookiesCount: cookies.length, activeCookiesCount, expiredCookiesCount: cookies.length - activeCookiesCount,
    sessionCookiesCount: cookies.filter(cookie => cookie.expires === -1).length,
    originsCount: origins.length, localStorageEntriesCount, indexedDBDatabasesCount, indexedDBStoresCount, indexedDBRecordsCount,
    hasData: activeCookiesCount + localStorageEntriesCount + indexedDBRecordsCount > 0 };
}
function compareRestoredSession(saved, restored, now = Date.now()) {
  const summary = sessionSummary(saved, now);
  const cookies = new Map(restored.cookies.map(cookie => [cookieKey(cookie), cookie]));
  let missingCookies = 0, missingLocalStorageEntries = 0, mismatchedIndexedDBItems = 0;
  const cookieMismatches={absent:0,value:0,expires:0,secure:0,httpOnly:0,sameSite:0};
  for (const cookie of saved.cookies.filter(cookie => cookieActive(cookie, now))) {
    const actual = cookies.get(cookieKey(cookie));
    if (!actual) { cookieMismatches.absent++; missingCookies++; continue; }
    let mismatch=false;
    for(const field of ['value','expires','secure','httpOnly','sameSite'])if(cookie[field]!==actual[field]){cookieMismatches[field]++;mismatch=true;}
    if(mismatch)missingCookies++;
  }
  const origins = new Map(restored.origins.map(origin => [origin.origin, origin]));
  for (const origin of saved.origins) {
    const actual = origins.get(origin.origin);
    const entries = new Map((actual?.localStorage ?? []).map(entry => [entry.name, entry.value]));
    for (const entry of origin.localStorage) if (entries.get(entry.name) !== entry.value) missingLocalStorageEntries++;
    const databases = new Map((actual?.indexedDB ?? []).map(database => [database.name, database]));
    for (const database of origin.indexedDB ?? []) {
      const actualDatabase = databases.get(database.name);
      if (!actualDatabase || actualDatabase.version !== database.version) { mismatchedIndexedDBItems++; continue; }
      const stores = new Map(actualDatabase.stores.map(store => [store.name, store]));
      for (const store of database.stores) {
        const actualStore = stores.get(store.name);
        const schema = ({ records, indexes, ...fields }) => ({ ...fields, indexes: [...indexes].sort((a, b) => a.name.localeCompare(b.name)) });
        if (!actualStore || canonical(schema(store)) !== canonical(schema(actualStore))) { mismatchedIndexedDBItems++; continue; }
        // Compare records as a multiset: inline keys are absent in Playwright's
        // export, and cursor order is not part of the saved session identity.
        const records = new Map();
        for (const record of actualStore.records) { const key = recordSignature(record); if (key !== null) records.set(key, (records.get(key) ?? 0) + 1); }
        for (const record of store.records) {
          const key = recordSignature(record), count = records.get(key) ?? 0;
          if (key === null || !count) mismatchedIndexedDBItems++;
          else records.set(key, count - 1);
        }
      }
    }
  }
  const errorCode = !saved.savedAt ? 'profile_session_missing' : !summary.hasData ? 'profile_session_empty'
    : missingCookies || missingLocalStorageEntries || mismatchedIndexedDBItems ? 'profile_session_verification_failed' : null;
  return { version: 1, status: errorCode ? 'failed' : 'passed', checkedAt: new Date(now).toISOString(), sourceSavedAt: saved.savedAt,
    errorCode, ...summary, checks: { cookies: missingCookies === 0, localStorage: missingLocalStorageEntries === 0, indexedDB: mismatchedIndexedDBItems === 0 },
    missingCookies, missingLocalStorageEntries, mismatchedIndexedDBItems, cookieMismatches };
}
module.exports = { cookieActive, sessionSummary, compareRestoredSession, storageStateSchema };
