const { z } = require('zod');

const DEFAULT_MAX_PROFILE_BYTES = 50_000_000;
const size = z.union([z.number(),z.string().min(1)]).pipe(z.coerce.number().int().min(1).max(1_000_000_000));
function maxProfileBytes(value = process.env.WORKER_MAX_PROFILE_BYTES ?? DEFAULT_MAX_PROFILE_BYTES) {
  const result = size.safeParse(value);
  if (!result.success) throw Object.assign(new Error('invalid_max_profile_bytes'), { code: 'invalid_max_profile_bytes' });
  return result.data;
}

module.exports = { DEFAULT_MAX_PROFILE_BYTES, maxProfileBytes };
