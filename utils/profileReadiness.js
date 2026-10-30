const cookieAge=require('./cookieAge.js');
// Increment when the restart verification contract changes. SQL eligibility
// uses this scalar stamp; allocation and file preflight also check the evidence.
const VERIFICATION_VERSION = 1;
function verifiedSnapshot(check, snapshotId, savedAt, passportHash) {
  return Boolean(snapshotId && check?.status === 'passed' &&
    check.verificationVersion === VERIFICATION_VERSION && check.processRestartVerified === true &&
    check.sourceSnapshotId === snapshotId && typeof check.runtimeVersion === 'string' && check.runtimeVersion.length > 0 &&
    typeof check.passportHash === 'string' && /^[a-f0-9]{64}$/.test(check.passportHash) &&
    Number.isFinite(Date.parse(check.checkedAt)) && Number.isFinite(Date.parse(check.sourceSavedAt)) &&
    (savedAt === undefined || check.sourceSavedAt === savedAt) &&
    (passportHash === undefined || check.passportHash === passportHash));
}
function confirmed(profile, now = Date.now()) {
  return cookieAge.gatePassed(profile.sessionCheck,now) && profile.readinessVersion === VERIFICATION_VERSION && verifiedSnapshot(profile.sessionCheck, profile.snapshotId) &&
    profile.status === 'ready' && profile.isEnabled && !profile.deletedAt && Boolean(profile.warmedAt) &&
    profile.fingerprintState === 'verified' && Boolean(profile.readinessVerifiedAt) && new Date(profile.readinessValidUntil).getTime() > now;
}
function attestable(profile, session, job = profile.warmupJob, now = Date.now()) {
  return cookieAge.gatePassed(profile.sessionCheck,now) && verifiedSnapshot(profile.sessionCheck, session?.snapshotId, session?.savedAt, session?.passportHash) &&
    Boolean(session?.passportHash) && session?.hasData && session.state === 'saved' && profile.fingerprintState === 'verified' &&
    (!job?.minReadyAt || new Date(job.minReadyAt).getTime() <= now) && (!job || job.currentStage >= job.totalStages);
}
const needsCheckWhere = (now = new Date()) => ({ deletedAt: null, OR: [
  { status: 'needs_check' },
  { status: 'ready', OR: [{ readinessVersion: { not: VERIFICATION_VERSION } }, { snapshotId: null },
    { readinessVerifiedAt: null }, { readinessValidUntil: null }, { readinessValidUntil: { lte: now } }] },
] });
const eligibleWhere = (projectId, now = new Date()) => ({ status: 'ready', isEnabled: true, deletedAt: null,
  warmedAt: { not: null }, fingerprintState: 'verified', snapshotId: { not: null }, readinessVersion: VERIFICATION_VERSION,
  readinessVerifiedAt: { not: null }, readinessValidUntil: { gt: now },
  ...(projectId ? { projectUses: { none: { projectId } }, projectHistory: { none: { projectId } } } : {}) });
module.exports = { VERIFICATION_VERSION, verifiedSnapshot, confirmed, attestable, eligibleWhere, needsCheckWhere };
