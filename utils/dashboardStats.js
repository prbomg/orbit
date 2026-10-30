const { visitWindow } = require('./projectVisits');
const HOUR = 3600000, DAY = 24 * HOUR, OFFSET = 3 * HOUR;
async function dashboardStats(db, period = 'today', now = Date.now()) {
  if (!['today', 'week'].includes(period)) throw new Error('invalid_period');
  const week = visitWindow({ period: 'week' }, now), today = visitWindow({ period: 'today' }, now);
  const start = +(period === 'today' ? today.start : week.start), size = period === 'today' ? HOUR : DAY;
  const count = period === 'today' ? 24 : 7;
  const buckets = Array.from({length: count}, (_, i) => ({ at: new Date(start + i * size).toISOString(), label: period === 'today' ? `${String(i).padStart(2, '0')}:00` : new Date(start + i * size + OFFSET).toISOString().slice(5, 10).split('-').reverse().join('.'), completed: 0, failed: 0 }));
  const totals = { completed: 0, failed: 0 }, todayTotals = { completed: 0, failed: 0 };
  let cursor;
  for (;;) {
    const rows = await db.taskExecution.findMany({ where: { status: { in: ['completed','failed'] }, completedAt: { gte: week.start, lt: new Date(Math.min(+week.end, now + 1)) }, OR: [{ errorCode: null }, { errorCode: { not: 'stopped' } }] }, select: { id:true, status:true, completedAt:true }, orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const row of rows) {
      const at = +new Date(row.completedAt), key = row.status;
      if (at >= +today.start) todayTotals[key]++;
      const index = Math.floor((at - start) / size);
      if (index >= 0 && index < count) { buckets[index][key]++; totals[key]++; }
    }
    if (rows.length < 1000) break; cursor = rows.at(-1).id;
  }
  return { period, timezone: 'Europe/Moscow', today: todayTotals, totals, buckets };
}
module.exports = { dashboardStats };
