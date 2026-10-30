const { Readable } = require('node:stream');
const yazl = require('yazl');
const store = require('./taskLogStore.js');
const fail = (message, status = 400) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'private, no-store' } });
const attachment = (type, name) => ({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
function summary(a) {
  return { id: a.id, source: a.source || 'attempt', executionId: a.executionId, startedAt: a.startedAt, executionStartedAt: a.executionStartedAt,
    attempt: a.attempt, finishedAt: a.finishedAt, status: a.status, errorCode: a.errorCode,
    events: a.events, dropped: a.dropped, expiredAt: a.expiredAt,
    parts: a.parts.map(p => ({ name: p.name, bytes: p.bytes })) };
}
async function response(request, taskId, root = store.rootPath()) {
  const q = new URL(request.url).searchParams;
  const mode = q.get('format') || 'txt';
  if (!['index', 'txt', 'zip'].includes(mode)) return fail('Неизвестный формат');
  const executionId = q.get('executionId'), attemptId = q.get('attemptId'), startedAt = q.get('startedAt');
  if ((executionId && !store.safeId(executionId)) || (attemptId && !store.safeId(attemptId)) || (startedAt && !Number.isFinite(Date.parse(startedAt)))) return fail('Некорректная попытка');
  const cat = await store.readCatalog(root);
  let attempts = cat.attempts.filter(a => a.taskId === taskId);
  if (executionId) attempts = attempts.filter(a => a.executionId === executionId);
  if (startedAt) attempts = attempts.filter(a => a.executionStartedAt === new Date(startedAt).toISOString());
  if (attemptId) attempts = attempts.filter(a => a.id === attemptId);
  const from = q.get('from'), to = q.get('to');
  let period = null;
  if ((!attemptId && mode === 'zip') || from || to) {
    const begin = Date.parse(from), end = Date.parse(to);
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end || end - begin > 90 * 86400000) return fail('Задайте период до 90 дней: начало должно быть раньше окончания');
    period = { from: new Date(begin).toISOString(), to: new Date(end).toISOString() };
    // Include attempts overlapping the requested interval. Preserve the entire
    // attempt for diagnosis; document these semantics in the archive.
    attempts = attempts.filter(a => Date.parse(a.startedAt) < end && Date.parse(a.finishedAt || a.updatedAt) >= begin);
  }
  if (mode === 'index') return Response.json({ partBytes: store.PART_BYTES, budgetBytes: store.BUDGET_BYTES,
    attempts: attempts.sort((a,b) => b.startedAt.localeCompare(a.startedAt)).map(summary),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
  if (mode === 'txt') {
    if (!attemptId) return fail('Выберите попытку в журнале выполнения');
    const a = attempts[0]; if (!a) return fail('Лог этой попытки отсутствует или срок хранения истёк', 404);
    const name = q.get('part') || a.parts[0]?.name;
    const part = a.parts.find(p => p.name === name);
    if (!part) return fail('Подробный лог удалён по политике хранения либо ещё не записан', 410);
    try {
      const body = await store.readPart(root, a, part);
      return new Response(body, { headers: attachment('text/plain; charset=utf-8', `task-${taskId}-${a.id}-${part.name}`) });
    } catch (e) { if (e.code === 'ENOENT') return fail('Эта часть уже удалена по политике хранения', 410); throw e; }
  }
  if (!attempts.length) return fail('За выбранный период нет сохранённых логов', 404);
  let release;
  try { release = await store.acquireReadLease(root, attempts.map(a => a.id)); }
  catch (error) { if (error.status) return fail(error.message, error.status); throw error; }
  const fresh = await store.readCatalog(root).catch(async error => { await release(); throw error; });
  attempts = attempts.map(a => fresh.attempts.find(current => current.id === a.id) || { ...a, parts: [], expiredAt: new Date().toISOString() });
  const zip = new yazl.ZipFile();
  const files = attempts.reduce((sum,a) => sum + a.parts.length, 0);
  const note = 'Orbit: технические логи. UTF-8, части не больше 64 КиБ.\n' +
    'Период выбирает пересекающиеся попытки; их доступные логи включены полностью.\n' +
    'summary.json содержит идентификаторы, результаты и сведения об удалённых/пропущенных деталях.\n' +
    'Активные попытки отражают состояние на момент запроса. Старые монолитные логи включены отдельными группами legacy-task-log; они не разделены на попытки.\n';
  zip.addBuffer(Buffer.from(note), 'README.txt');
  zip.addBuffer(Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), period, parts: files, attempts: attempts.map(summary) }, null, 2)), 'summary.json');
  for (const a of attempts) for (const part of a.parts) {
    zip.addReadStreamLazy(`${a.startedAt.replace(/[:.]/g, '-')}_${a.id}/${part.name}`, { size: part.bytes }, callback => {
      store.readPart(root, a, part).then(buffer => callback(null, Readable.from(buffer)), error => callback(error));
    });
  }
  const abort = () => zip.outputStream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  zip.on('error', error => zip.outputStream.destroy(error));
  zip.outputStream.once('close', () => { request.signal.removeEventListener('abort', abort); void release(); });
  zip.end();
  if (request.signal.aborted) abort();
  return new Response(Readable.toWeb(zip.outputStream), { headers: attachment('application/zip', `task-${taskId}-history.zip`) });
}
module.exports = { response };
