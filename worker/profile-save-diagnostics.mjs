// Never retain error.message, stack, cookie values, storage keys, URLs or unknown field names.
const stages = new Set(['directory', 'storage_export', 'cookies_export', 'fingerprint', 'runtime',
  'cookie_observations', 'validation', 'snapshot_stamp', 'serialization', 'size_check',
  'file_open', 'file_write', 'file_sync', 'file_close', 'session_summary']);
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ZodError', 'ProfileError', 'TimeoutError']);
const issueCodes = new Set(['invalid_type', 'invalid_literal', 'unrecognized_keys', 'invalid_union',
  'invalid_union_discriminator', 'invalid_enum_value', 'invalid_arguments', 'invalid_return_type',
  'invalid_date', 'invalid_string', 'too_small', 'too_big', 'invalid_intersection_types',
  'not_multiple_of', 'not_finite', 'custom', 'invalid_value', 'invalid_format', 'invalid_key', 'invalid_element']);
const fields = new Set(('snapshot version identityHashVersion id passportHash contentHash storageMode warmupStage '
  + 'passport timezone seed projectLocations cookieObservations key name domain valueHash firstSeenAt expires '
  + 'runtime battery profileId mobileOS canvasSeed createdAt savedAt fingerprint canvas mode navigator userAgent '
  + 'language languages maxTouchPoints screen width height devicePixelRatio innerWidth innerHeight videoCard '
  + 'vendor renderer headers cookies value path httpOnly secure sameSite partitionKey _crHasCrossSiteAncestor '
  + 'origins origin localStorage indexedDB stores autoIncrement keyPath keyPathArray indexes multiEntry unique '
  + 'records keyEncoded valueEncoded').split(' '));

export function profileSaveDiagnostics(error, stage) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  return {
    stage: stages.has(stage) ? stage : 'unknown',
    sourceErrorType: errorTypes.has(error?.name) ? error.name : 'Error',
    issueCount: issues.length,
    issues: issues.slice(0, 20).map(issue => ({
      code: issueCodes.has(issue?.code) ? issue.code : 'unknown',
      path: (Array.isArray(issue?.path) ? issue.path : []).slice(0, 16).map(part =>
        typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && part <= 1_000_000
          ? part : typeof part === 'string' && fields.has(part) ? part : '[field]'),
    })),
    issuesTruncated: issues.length > 20 || issues.some(issue => Array.isArray(issue?.path) && issue.path.length > 16),
  };
}
