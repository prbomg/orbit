import geo from '../utils/projectGeolocation.js';
const permissionSessions = new WeakMap();
export const projectPermissionSession = context => permissionSessions.get(context);

// The scheduler supplies the newly allocated execution inside its transaction.
// The runner reads that reservation, never a profile's historical coordinates.
export async function reserveProjectLocation(tx, project, profileId, execution = null) {
  if (!geo.locationArea(project)) return null;
  if (execution) {
    if (execution.profileId !== profileId || execution.status !== 'running' ||
        !execution.id || !Number.isInteger(execution.attempts) || execution.attempts < 1) {
      throw Error('invalid_geolocation_execution');
    }
    return { ...geo.createProjectLocation(project), scope: 'execution',
      executionId: execution.id, attempt: execution.attempts };
  }
  const use = await tx.projectProfileUse.findUnique({
    where: { projectId_profileId: { projectId: project.id, profileId } },
    select: { taskId: true, geolocation: true },
  });
  // Standalone sessions without a scheduler reservation also get a fresh point.
  if (!use) return geo.createProjectLocation(project);
  const current = use.taskId ? await tx.taskExecution.findUnique({
    where: { taskId_profileId: { taskId: use.taskId, profileId } },
    select: { id: true, status: true, attempts: true },
  }) : null;
  const location = use.geolocation;
  if (!current || current.status !== 'running' || location?.scope !== 'execution' ||
      location.executionId !== current.id || location.attempt !== current.attempts ||
      !geo.validProjectLocation(location, project)) {
    throw Error('invalid_saved_execution_geolocation');
  }
  return location;
}

export async function applyProjectGeolocation(context, location, project) {
  if (!location) return;
  if (!geo.validProjectLocation(location, project)) throw Error('invalid_saved_project_geolocation');
  await context.setGeolocation(geo.browserGeolocation(location));
  // Set one permission descriptor. grantPermissions() would deny every other
  // descriptor on these origins, interfering with the independent sensor setup.
  const page = context.pages()[0] || await context.newPage();
  const probe = await context.newCDPSession(page);
  let targetInfo;
  try { ({ targetInfo } = await probe.send('Target.getTargetInfo')); }
  finally { await probe.detach().catch(() => {}); }
  const session = await context.browser().newBrowserCDPSession();
  try {
    for (const origin of geo.locationOrigins(project)) await session.send('Browser.setPermission', {
      permission: { name: 'geolocation' }, setting: 'granted', origin,
      ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
    });
  } catch (error) { await session.detach().catch(() => {}); throw error; }
  permissionSessions.set(context, session);
  // Chromium ties permission overrides to this CDP session. Detaching here
  // silently resets them before the first navigation.
  context.once('close', () => { permissionSessions.delete(context); void session.detach().catch(() => {}); });
}
