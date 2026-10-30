import { randomUUID } from 'node:crypto';
import readiness from '../../utils/profileReadiness.js';
export function attestedSession({ snapshotId = randomUUID(), savedAt = new Date().toISOString(), passportHash = 'a'.repeat(64) } = {}) {
  return { hasData: true, snapshotId, savedAt, passportHash, sessionCheck: { version: 1, status: 'passed',
    verificationVersion: readiness.VERIFICATION_VERSION, processRestartVerified: true, runtimeVersion: '153.0.0.0',
    checkedAt: new Date().toISOString(), sourceSnapshotId: snapshotId, sourceSavedAt: savedAt, passportHash } };
}
