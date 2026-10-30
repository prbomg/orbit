const catalog = require('./deviceCatalog.js');
const fp = require('./fingerprint.js');

// Compact public metadata: never expose seeds, cookies or the full passport in a list.
function profileGeneration(passport) {
  const p = passport && typeof passport === 'object' ? passport : {};
  const reference = p.deviceTemplate;
  const template = reference && catalog.findTemplate(reference.id, reference.catalogVersion, reference.revision);
  const version = p.generation?.version ?? null;
  const adapter = p.generation?.adapter ?? null;
  const current = version === fp.CURRENT_GENERATION_VERSION && p.fingerprint?.canvas?.version === 1 && p.fingerprint.canvas.mode === 'native' && (
    p.source === 'local' && adapter === fp.CURRENT_ADAPTER_VERSION && reference?.catalogVersion === catalog.DEVICE_CATALOG.version && Boolean(p.fingerprint?.gpu)
    || p.source === 'mobileproxy' && adapter === 'mobileproxy-v1'
  );
  return { current, version, adapter, catalogVersion: reference?.catalogVersion ?? null,
    model: template?.name || p.fingerprint?.navigator?.userAgentData?.model || null,
    android: template?.os || p.fingerprint?.navigator?.userAgentData?.platformVersion || null,
    source: p.source || null };
}
module.exports = { profileGeneration };
