import { performance } from 'node:perf_hooks';
import { projectPermissionSession } from './project-geolocation.mjs';
import { createMotionModel, motionAtTime, createMotionCadence, createTouchMotionResponse } from './motion-model.mjs';
import { observeTouchActivity } from './touch-trajectory.mjs';

export const MOTION_SENSORS = Object.freeze(['relative-orientation', 'absolute-orientation', 'accelerometer', 'linear-acceleration', 'gravity', 'gyroscope']);
const pageStates = new WeakMap();
async function bounded(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('motion_command_timeout')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export function motionDiagnostics(page) {
  const state = pageStates.get(page);
  return state ? { mode: state.mode, scenario: state.scenario, state: state.status,
    backend: 'cdp-sensors', updateHz: state.updateHz, updateIntervalMs: state.updateIntervalMs,
    nativeEventCadence: 'browser-controlled', touchCoupled: state.status === 'active', ...state.reaction.diagnostics(),
    permission: state.permission || 'unchanged', ...(state.reason ? { reason: state.reason } : {}) }
    : { mode: 'off', state: 'disabled' };
}

/** One session timeline across pages, with sensor-only session permissions and no injected events. */
export function startMotionEmulation(context, { mode = 'quiet-held', signal, log = () => {}, taskId, model = createMotionModel() } = {}) {
  if (!['quiet-held', 'off'].includes(mode)) throw new Error('Invalid motion mode');
  const records = new Map(); const started = performance.now();
  const cadence = createMotionCadence(model), reaction = createTouchMotionResponse(model);
  const seconds = () => (performance.now() - started) / 1000;
  let stopped = false, timer, tickPromise = Promise.resolve(), stopPromise, permissionsReady;
  const allowSensors = cdp => {
    if (!permissionsReady) permissionsReady = (async () => {
      const { targetInfo } = await bounded(cdp.send('Target.getTargetInfo'));
      // Share the context-lifetime permission owner when project GPS is active.
      // Otherwise detaching a sensor page session resets its geolocation too.
      const permissions = projectPermissionSession(context) || cdp;
      // Browser.grantPermissions denies unrelated permissions. Set only these
      // descriptors, scoped to this private profile's browser context instead.
      for (const name of ['accelerometer', 'gyroscope', 'magnetometer']) await bounded(permissions.send('Browser.setPermission', {
        permission: { name }, setting: 'granted',
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
      }));
    })();
    return permissionsReady;
  };
  const disable = async record => {
    record.unsubscribe?.();
    if (record.touching) { reaction.touch('touchCancel', null, seconds()); record.touching = false; }
    const cdp = record.cdp;
    if (!cdp) return;
    // Chromium can drop replies during target destruction. Never let optional
    // sensor cleanup block SIGTERM, lock release or the browser's shutdown.
    if (!record.page.isClosed()) await Promise.all(record.enabled.map(type => bounded(cdp.send('Emulation.setSensorOverrideEnabled', { enabled: false, type })).catch(() => {})));
    await bounded(cdp.detach(), 250).catch(() => {});
    record.cdp = null;
  };
  const update = async (record, reading) => {
    await Promise.all(MOTION_SENSORS.map(type => bounded(record.cdp.send('Emulation.setSensorOverrideReadings', {
      type, reading: type.endsWith('orientation') ? { quaternion: reading.quaternion } : { xyz: {
        ...({ accelerometer: reading.accelerometer, 'linear-acceleration': reading.linearAcceleration, gravity: reading.gravity, gyroscope: reading.gyroscope }[type]),
      } },
    }))));
  };
  const fail = async (record, error) => {
    if (stopped || record.page.isClosed()) record.status = 'stopped';
    else {
      record.status = 'unavailable';
      record.reason = /not found|wasn't found|not supported|Invalid parameters/i.test(error?.message || '') ? 'motion_cdp_unsupported' : 'motion_backend_unavailable';
      log('motion_emulation_unavailable', { taskId, reason: record.reason });
    }
    await disable(record);
  };
  const prepare = page => {
    if (records.has(page)) return records.get(page).ready;
    if (stopped || page.isClosed()) return Promise.resolve();
    const record = { page, cdp: null, enabled: [], status: mode === 'off' ? 'disabled' : 'starting', mode: mode === 'off' ? 'off' : 'simulated', scenario: model.scenario,
      updateHz: 1000 / cadence.intervalMs, updateIntervalMs: { min: cadence.minMs, max: cadence.maxMs }, reaction };
    records.set(page, record); pageStates.set(page, record);
    if (mode !== 'off') record.unsubscribe = observeTouchActivity(page, activity => {
      if (stopped || record.status !== 'active') return;
      reaction.touch(activity.type, activity.point, (activity.at - started) / 1000);
      record.touching = ['touchStart', 'touchMove'].includes(activity.type);
    });
    record.onClose = () => { record.status = 'stopped'; records.delete(page); void record.ready.then(() => disable(record)).catch(() => {}); };
    page.once('close', record.onClose);
    record.ready = (async () => {
      if (mode === 'off') return;
      try {
        record.cdp = await bounded(context.newCDPSession(page));
        await allowSensors(record.cdp); record.permission = 'session-granted';
        for (const type of MOTION_SENSORS) {
          if (stopped || page.isClosed()) break;
          await bounded(record.cdp.send('Emulation.setSensorOverrideEnabled', { enabled: true, type, metadata: { available: true, minimumFrequency: 1, maximumFrequency: cadence.maximumSensorHz } }));
          record.enabled.push(type);
        }
        if (stopped || page.isClosed()) { await disable(record); return; }
        await update(record, motionAtTime(model, seconds(), reaction));
        record.status = 'active';
        log('motion_emulation_started', { taskId, source: 'simulated', scenario: model.scenario, updateHz: record.updateHz, updateIntervalMs: record.updateIntervalMs, touchCoupled: true });
      } catch (error) { await fail(record, error); }
    })();
    return record.ready;
  };
  const schedule = () => {
    if (stopped || mode === 'off') return;
    timer = setTimeout(() => {
      tickPromise = (async () => {
        const reading = motionAtTime(model, seconds(), reaction);
        await Promise.all([...records.values()].filter(r => r.status === 'active').map(async record => {
          try { await update(record, reading); } catch (error) { await fail(record, error); }
        }));
      })();
      void tickPromise.then(schedule, schedule);
    }, cadence.next());
    timer.unref?.();
  };
  const onPage = page => { void prepare(page); };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true; clearTimeout(timer); context.off('page', onPage); context.off('close', onClose); signal?.removeEventListener('abort', onAbort);
    stopPromise = (async () => {
      await Promise.all([...records.values()].map(r => r.ready)); await tickPromise;
      await Promise.all([...records.values()].map(async r => { r.page.off('close', r.onClose); r.status = 'stopped'; await disable(r); }));
      records.clear();
      reaction.clear();
    })();
    return stopPromise;
  };
  const onAbort = () => { void stop().catch(() => {}); };
  const onClose = onAbort;
  context.on('page', onPage); context.once('close', onClose); signal?.addEventListener('abort', onAbort, { once: true });
  for (const page of context.pages()) void prepare(page);
  if (signal?.aborted) onAbort(); else schedule();
  return { prepare, stop };
}
