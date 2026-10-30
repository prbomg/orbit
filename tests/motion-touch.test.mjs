import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createMotionModel, createMotionCadence, createTouchMotionResponse, motionAtTime, multiplyQuaternion, GRAVITY } from '../worker/motion-model.mjs';
import { startMotionEmulation, motionDiagnostics } from '../worker/motion-emulation.mjs';
import { dispatchTouchEvent, observeTouchActivity } from '../worker/touch-trajectory.mjs';
import { scrollPage } from '../worker/mobile-input.mjs';
const norm = v => Math.hypot(v.x, v.y, v.z);
const close = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('per-session cadence varies within 48–56 ms and is reproducible for test seeds', () => {
  const means = [];
  for (let seed = 0; seed < 100; seed++) {
    const model = createMotionModel(`cadence-${seed}`), a = createMotionCadence(model), b = createMotionCadence(model);
    const samples = Array.from({ length: 1000 }, () => a.next());
    assert.deepEqual(samples, Array.from({ length: 1000 }, () => b.next()));
    assert.ok(samples.every(ms => ms >= 48 && ms <= 56));
    assert.ok(Math.max(...samples) - Math.min(...samples) > 3.8);
    means.push(samples.reduce((sum, ms) => sum + ms, 0) / samples.length);
  }
  assert.ok(Math.max(...means) - Math.min(...means) > 3.5);
});

test('touch produces bounded tilt and consistent angular velocity/acceleration, then decays to rest', () => {
  const model = createMotionModel('physics'); model.angular = [[], [], []]; model.translation = [[], [], []];
  const reaction = createTouchMotionResponse(model);
  const initial = motionAtTime(model, 1, reaction);
  reaction.touch('touchStart', { x: 100, y: 500 }, 1);
  const contact = motionAtTime(model, 1, reaction);
  assert.deepEqual(contact.angles, initial.angles);
  close(norm(contact.gyroscope), norm(initial.gyroscope), 1e-5);
  assert.deepEqual(contact.linearAcceleration, initial.linearAcceleration);
  const held = motionAtTime(model, 3, reaction);
  for (const name of ['beta', 'gamma']) assert.ok(Math.abs(held.angles[name] - model.base[name]) >= .799 && Math.abs(held.angles[name] - model.base[name]) <= 2.201);
  const moving = motionAtTime(model, 1.1, reaction);
  assert.ok(Math.abs(moving.linearAcceleration.y) > .0001 && Math.abs(moving.linearAcceleration.z) > .0001);
  reaction.touch('touchMove', { x: 105, y: 350 }, 3.1);
  reaction.touch('touchEnd', null, 4);
  for (let t = 1.001; t <= 8; t += .019) {
    const r = motionAtTime(model, t, reaction);
    close(Math.hypot(r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w), 1); close(norm(r.gravity), GRAVITY);
    for (const key of ['x', 'y', 'z']) close(r.accelerometer[key] - r.linearAcceleration[key], r.gravity[key]);
    for (const key of ['beta', 'gamma']) assert.ok(Math.abs(r.angles[key] - model.base[key]) <= 2.201);
    const dt = .00001, next = motionAtTime(model, t + dt, reaction).quaternion;
    const dq = multiplyQuaternion({ x: -r.quaternion.x, y: -r.quaternion.y, z: -r.quaternion.z, w: r.quaternion.w }, next);
    for (const key of ['x', 'y', 'z']) close(dq[key] * 2 / dt, r.gyroscope[key], .00003);
    const before = reaction.sampleAt(t - dt).displacement, at = reaction.sampleAt(t), after = reaction.sampleAt(t + dt).displacement;
    for (const key of ['x', 'y', 'z']) close((after[key] - 2 * at.displacement[key] + before[key]) / dt ** 2, at.worldAcceleration[key], .000001);
  }
  const settled = motionAtTime(model, 9, reaction);
  close(settled.angles.beta, model.base.beta); close(settled.angles.gamma, model.base.gamma);
  assert.ok(norm(settled.linearAcceleration) < 1e-7 && norm(settled.gyroscope) < 1e-7);
});

test('dense touchMove cannot accumulate unbounded impulses; cancellation and repeated gestures settle', () => {
  const model = createMotionModel('dense'), reaction = createTouchMotionResponse(model);
  for (let gesture = 0; gesture < 1000; gesture++) {
    const at = gesture * .3;
    reaction.touch('touchStart', { x: 100, y: 600 }, at);
    for (let move = 0; move < 20; move++) reaction.touch('touchMove', { x: 100, y: 600 - move * 10 }, at + move * .01);
    reaction.touch(gesture % 2 ? 'touchCancel' : 'touchEnd', null, at + .21);
    const response = reaction.sampleAt(at + .22);
    assert.ok(Math.abs(response.beta) <= 2.201 && Math.abs(response.gamma) <= 2.201);
    assert.ok(reaction.diagnostics().retainedEvents < 150);
  }
  assert.equal(reaction.diagnostics().active, false);
  close(reaction.sampleAt(310).beta, 0);
});

test('only accepted CDP touches notify observers; unsubscribe and controllers are isolated', async () => {
  const page = new EventEmitter(); page.isClosed = () => false;
  const context = new EventEmitter(); context.pages = () => [page];
  context.newCDPSession = async () => ({ send: async method => method === 'Target.getTargetInfo' ? { targetInfo: {} } : undefined, detach: async () => {} });
  const cdp = { send: async () => {} }, point = [{ x: 50, y: 300 }];
  let observed = 0;
  const oldOff = observeTouchActivity(page, () => observed++); oldOff();
  const off = observeTouchActivity(page, () => observed++); oldOff();
  const throwOff = observeTouchActivity(page, () => { throw Error('optional observer'); });
  await assert.rejects(dispatchTouchEvent(page, { send: async () => { throw Error('rejected'); } }, 'touchStart', point));
  assert.equal(observed, 0);
  const otherPage = new EventEmitter(); otherPage.isClosed = () => false;
  const otherContext = new EventEmitter(); otherContext.pages = () => [otherPage]; otherContext.newCDPSession = context.newCDPSession;
  const other = startMotionEmulation(otherContext); await other.prepare(otherPage);
  const controller = startMotionEmulation(context); await controller.prepare(page);
  await dispatchTouchEvent(page, cdp, 'touchStart', point);
  assert.equal(motionDiagnostics(otherPage).gestures, 0);
  assert.equal(observed, 1); assert.equal(motionDiagnostics(page).gestures, 1); assert.equal(motionDiagnostics(page).active, true);
  await dispatchTouchEvent(page, cdp, 'touchCancel', []);
  assert.equal(motionDiagnostics(page).active, false);
  await controller.stop();
  await dispatchTouchEvent(page, cdp, 'touchStart', point);
  assert.equal(motionDiagnostics(page).gestures, 1, 'stopped controller receives no input');
  await other.stop(); off(); throwOff();
});

test('real swipe changes native sensor readings and releases into decay without synthesizing DOM events', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    await context.route('https://motion-touch.test/**', route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;height:8000px}</style>' }));
    const model = createMotionModel('browser-touch'); model.angular = [[], [], []]; model.translation = [[], [], []];
    const controller = startMotionEmulation(context, { model });
    try {
      const page = await context.newPage(); await controller.prepare(page); await page.goto('https://motion-touch.test/');
      await page.evaluate(() => {
        window.samples = []; window.touchCount = 0;
        addEventListener('touchstart', () => touchCount++);
        addEventListener('deviceorientation', e => samples.push({ beta: e.beta, gamma: e.gamma, at: performance.now(), trusted: e.isTrusted }));
        window.acceleration = []; window.linear = [];
        window.linearSensor = new LinearAccelerationSensor({ frequency: 20 });
        linearSensor.addEventListener('reading', e => linear.push({ y: linearSensor.y, z: linearSensor.z, trusted: e.isTrusted }));
        linearSensor.start();
        addEventListener('devicemotion', e => acceleration.push({ y: e.acceleration?.y, z: e.acceleration?.z, trusted: e.isTrusted, interval: e.interval }));
      });
      await page.waitForFunction(() => linear.length > 0);
      const baseline = { beta: model.base.beta, gamma: model.base.gamma };
      await scrollPage(page, 250, { durationMs: 700 });
      const moving = await page.evaluate(() => ({ samples, acceleration, linear, touchCount }));
      assert.equal(moving.touchCount, 1);
      assert.ok(moving.samples.some(s => Math.abs(s.beta - baseline.beta) > .5 || Math.abs(s.gamma - baseline.gamma) > .5));
      assert.ok(moving.linear.some(a => Math.abs(a.y) > .005 || Math.abs(a.z) > .005));
      assert.ok(moving.linear.every(a => a.trusted));
      assert.ok(moving.samples.every(s => s.trusted)); assert.ok(moving.acceleration.every(s => s.trusted));
      await page.waitForFunction(({ beta, gamma }) => Math.abs(samples.at(-1).beta - beta) < .11 && Math.abs(samples.at(-1).gamma - gamma) < .11, baseline, { timeout: 5000 });
      const diagnostics = motionDiagnostics(page);
      assert.equal(diagnostics.gestures, 1); assert.equal(diagnostics.active, false);
      assert.equal(diagnostics.nativeEventCadence, 'browser-controlled');
      assert.ok(diagnostics.updateIntervalMs.min >= 48 && diagnostics.updateIntervalMs.max <= 56);
    } finally { await controller.stop(); await context.close(); }
  } finally { await browser.close(); }
});
