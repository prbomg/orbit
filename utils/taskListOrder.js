const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
const newestFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);

function orderTasks(tasks, saved = []) {
  const ranks = new Map(saved.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) => {
    const left = ranks.get(a.id), right = ranks.get(b.id);
    if (left === undefined && right === undefined) return newestFirst(a, b);
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
  });
}

function groupTasks(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const id = task.projectId || 'unassigned';
    if (!groups.has(id)) groups.set(id, { id, name: task.project?.name || 'Без проекта', tasks: [] });
    groups.get(id).tasks.push(task);
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
}

function moveTask(tasks, source, target) {
  const from = tasks.findIndex(task => task.id === source), to = tasks.findIndex(task => task.id === target);
  if (from < 0 || to < 0 || from === to || tasks[from].projectId !== tasks[to].projectId) return tasks;
  const result = [...tasks], [task] = result.splice(from, 1);
  result.splice(to, 0, task);
  return result;
}

function readTaskListPreferences(text) {
  try {
    const value = JSON.parse(text);
    const ids = list => Array.isArray(list) && list.length <= 10000 && list.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id));
    if (value?.version !== 1 || !ids(value.collapsed) || !value.orders || typeof value.orders !== 'object' || Array.isArray(value.orders)) throw Error();
    const entries = Object.entries(value.orders);
    if (entries.length > 10000 || entries.some(([id, list]) => !ids([id]) || !ids(list))) throw Error();
    return { version: 1, collapsed: [...new Set(value.collapsed)], orders: Object.fromEntries(entries.map(([id, list]) => [id, [...new Set(list)]])) };
  } catch { return { version: 1, collapsed: [], orders: {} }; }
}

module.exports = { orderTasks, groupTasks, moveTask, readTaskListPreferences };
