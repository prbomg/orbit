import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { touchTap } from '../worker/touch-tap.mjs';
import { pageSessions } from '../worker/page-session.mjs';

test('tap contacts use the same elliptical radius and pressure ranges as swipes', async () => {
  const page = new EventEmitter(), events = [];
  pageSessions.set(page, { send: async (method, event) => { events.push({ method, ...event }); } });
  try {
    for (const value of [0, .5, 1]) await touchTap(page, 80, 120, { durationMs: 50, random: () => value });
    assert.deepEqual(events.map(event => event.type), ['touchStart', 'touchEnd', 'touchStart', 'touchEnd', 'touchStart', 'touchEnd']);
    const points = events.filter(event => event.type === 'touchStart').map(event => event.touchPoints[0]);
    for (const point of points) {
      assert.equal(point.x, 80); assert.equal(point.y, 120);
      assert.ok(point.radiusX >= 11 && point.radiusX <= 15.5);
      assert.ok(point.radiusY >= 12 && point.radiusY <= 17 && point.radiusY > point.radiusX);
      assert.ok(point.force >= .42 && point.force <= .78);
    }
    assert.equal(new Set(points.map(point => point.radiusX)).size, 3);
    assert.ok(events.filter(event => event.type === 'touchEnd').every(event => event.touchPoints.length === 0));
  } finally { pageSessions.delete(page); }
});
