function actionReason(profile, action, busy = false) {
  const job = profile.warmupJob;
  if (profile.deletedAt) return 'missing';
  if (action === 'delete') return busy ? 'busy' : null;
  if (action === 'disable') return !profile.isEnabled ? 'already_disabled' : null;
  if (action === 'enable') return profile.status === 'banned' ? 'banned' : profile.isEnabled ? 'already_enabled' : null;
  if (profile.status === 'banned' || !profile.isEnabled) return 'disabled';
  if (action === 'pause') return !job || !['queued', 'running', 'retry_wait', 'waiting_stage'].includes(job.status) ? 'not_running' : null;
  if (busy) return 'busy';
  if (action === 'resume') return job?.status !== 'paused' ? 'not_paused' : null;
  if (action === 'retry') return job && job.status !== 'failed' ? 'not_failed' : null;
  if (action === 'verify') {
    if (!profile.warmedAt) return 'not_prepared';
    return job && !['completed', 'failed', 'paused'].includes(job.status) ? 'already_queued' : null;
  }
  return null;
}
module.exports = { actionReason };
