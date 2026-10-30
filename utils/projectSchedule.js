// Monday first, one bit per hour. A selected cell permits new session starts.
const ALL_HOURS = '1'.repeat(168);
const DEFAULT_TIMEZONE = 'Europe/Moscow';
const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    const value = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(timeZone, value);
  }
  return formatters.get(timeZone);
}
function validTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { formatter(value); return true; } catch { return false; }
}
function isAllowed(project, now = new Date()) {
  const hours = project?.scheduleHours ?? ALL_HOURS;
  const zone = project?.scheduleTimezone ?? DEFAULT_TIMEZONE;
  if (!/^[01]{168}$/.test(hours) || !validTimezone(zone)) return false;
  try {
    const parts = formatter(zone).formatToParts(now);
    const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find(p => p.type === 'weekday')?.value);
    const hour = Number(parts.find(p => p.type === 'hour')?.value);
    return hours[day * 24 + hour] === '1';
  } catch { return false; }
}
function isWarmupAllowed(settings, now = new Date()) {
  return settings?.warmupEnabled !== false && isAllowed({ scheduleHours: settings?.warmupScheduleHours, scheduleTimezone: settings?.warmupScheduleTimezone }, now);
}
function preset(name) {
  if (name === 'random') {
    const indices = Array.from({ length: 168 }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const selected = new Set(indices.slice(0, Math.round(168 * 0.7)));
    return indices.map((_, i) => selected.has(i) ? '1' : '0').join('');
  }
  return Array.from({ length: 168 }, (_, i) => {
    const day = Math.floor(i / 24), hour = i % 24;
    return (name === 'all' || name === 'work' && day < 5 && hour >= 8 && hour < 20 ||
      name === 'day' && hour >= 8 && hour < 20 || name === 'night' && (hour >= 20 || hour < 8) || name === 'weekdays' && day < 5 || name === 'weekends' && day >= 5) ? '1' : '0';
  }).join('');
}
module.exports = { ALL_HOURS, DEFAULT_TIMEZONE, validTimezone, isAllowed, isWarmupAllowed, preset };
