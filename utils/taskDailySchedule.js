const { randomInt, createHash } = require('node:crypto');
const schedule = require('./projectSchedule.js');
const calendars = new Map(), formatters = new Map();
const MINUTE = 60000, STALE_MS = 5 * MINUTE;

function localParts(date, zone) {
  if (!formatters.has(zone)) {
    if (formatters.size >= 64) formatters.clear();
    formatters.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }));
  }
  const p = Object.fromEntries(formatters.get(zone).formatToParts(date).map(p => [p.type, p.value]));
  return { key: `${p.year}-${p.month}-${p.day}`, day: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday), hour: Number(p.hour) };
}

/** UTC intervals for one local calendar day, including repeated/skipped DST hours. */
function dayCalendar(project, now = new Date()) {
  const hours = project?.scheduleHours ?? schedule.ALL_HOURS, zone = project?.scheduleTimezone ?? schedule.DEFAULT_TIMEZONE;
  if (!/^[01]{168}$/.test(hours) || !schedule.validTimezone(zone)) return null;
  const dayKey = localParts(now, zone).key, key = `${zone}:${hours}:${dayKey}`;
  if (calendars.has(key)) return calendars.get(key);
  const anchor = Date.parse(`${dayKey}T00:00:00Z`), windows = [];
  let start, end;
  // Contemporary IANA offsets range from UTC-12 to UTC+14. Minute boundaries
  // also cover fractional offsets and DST transitions without assuming 24 h.
  for (let time = anchor - 18 * 3600000; time < anchor + 42 * 3600000; time += MINUTE) {
    const p = localParts(new Date(time), zone);
    if (p.key !== dayKey) continue;
    start ??= time; end = time + MINUTE;
    if (hours[p.day * 24 + p.hour] !== '1') continue;
    const last = windows[windows.length - 1];
    if (last && last.end === time) last.end += MINUTE;
    else windows.push({ start: time, end: time + MINUTE });
  }
  if (start === undefined) return null;
  const value = { dayKey, start, end, windows, timezone: zone };
  if (calendars.size >= 128) calendars.clear();
  calendars.set(key, value); return value;
}

/** Irregular bounded random gaps, spread across the remaining permitted time. */
function generateSlots(calendar, count, now = new Date(), random = () => randomInt(1, 0x100000000) / 0x100000000) {
  const windows = calendar.windows.map(w => ({ start: Math.max(w.start, +now), end: w.end })).filter(w => w.end > w.start);
  const duration = windows.reduce((sum, w) => sum + w.end - w.start, 0);
  if (!duration || count <= 0) return [];
  const gaps = Array.from({ length: count + 1 }, () => .25 + Math.min(3, -Math.log(Math.max(Number.MIN_VALUE, Math.min(1, random())))));
  const total = gaps.reduce((a, b) => a + b, 0), slots = [];
  let accumulated = 0;
  for (let i = 0; i < count; i++) {
    accumulated += gaps[i];
    let offset = duration * accumulated / total;
    for (const w of windows) {
      if (offset < w.end - w.start) { slots.push(Math.min(w.end - 1, Math.floor(w.start + offset))); break; }
      offset -= w.end - w.start;
    }
  }
  return slots;
}

function settingsKey(task) {
  return createHash('sha256').update(JSON.stringify([task.dailyExecutionLimit, task.targetExecutions, task.project?.scheduleHours ?? schedule.ALL_HOURS, task.project?.scheduleTimezone ?? schedule.DEFAULT_TIMEZONE])).digest('hex');
}

/** create=true must be called in the same transaction that reserves a session. */
async function dailyState(db, task, { now = new Date(), create = false, random } = {}) {
  if (task.dailyExecutionLimit == null) return { allowed: true, reason: null, completed: 0, reserved: 0, nextAt: null };
  const calendar = dayCalendar(task.project, now);
  if (!calendar) return { allowed: false, reason: 'schedule', completed: 0, reserved: 0, nextAt: null };
  const where = { taskId: task.id, startedAt: { gte: new Date(calendar.start), lt: new Date(calendar.end) } };
  const [completed, reserved] = await Promise.all([
    db.taskExecution.count({ where: { ...where, status: 'completed' } }),
    db.taskExecution.count({ where: { ...where, status: 'running' } }),
  ]);
  const used = completed + reserved, goal = Math.min(task.dailyExecutionLimit, task.targetExecutions - task.currentExecutions + completed);
  const result = { completed, reserved, nextAt: null };
  if (used >= goal) return { ...result, allowed: false, reason: 'daily_limit' };
  if (!schedule.isAllowed(task.project, now)) return { ...result, allowed: false, reason: 'schedule' };
  const key = settingsKey(task), unique = { taskId_dayKey: { taskId: task.id, dayKey: calendar.dayKey } };
  let plan = await db.taskDailyPlan.findUnique({ where: unique });
  const valid = plan?.settingsKey === key && Array.isArray(plan.slots) && plan.slots.every(Number.isSafeInteger);
  const missed = valid && (used < plan.baseCount || plan.slots[used - plan.baseCount] < +now - STALE_MS);
  if (create && (!valid || missed)) {
    const data = { settingsKey: key, baseCount: used, slots: generateSlots(calendar, goal - used, now, random) };
    plan = await db.taskDailyPlan.upsert({ where: unique, create: { taskId: task.id, dayKey: calendar.dayKey, ...data }, update: data });
  } else if (!valid) return { ...result, allowed: false, reason: 'daily_schedule' };
  const index = Math.max(0, used - plan.baseCount), next = plan.slots[index];
  const allowed = used < plan.baseCount || typeof next === 'number' && next <= +now;
  return { ...result, allowed, reason: allowed ? null : 'daily_schedule', nextAt: typeof next === 'number' ? new Date(Math.max(+now, next)) : null };
}
module.exports = { dayCalendar, generateSlots, settingsKey, dailyState, STALE_MS };
