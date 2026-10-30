async function controlTask(id, action, { fetchImpl = fetch, signal, now = Date.now, wait = pause, stopTimeoutMs = 30000 } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !['start', 'pause', 'restart'].includes(action)) throw Error('Некорректная команда задачи');
  const path = `/api/tasks/${id}/`;
  const request = async (status) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(path, {
      method: status ? 'PATCH' : 'GET', cache: 'no-store', signal,
      ...(status ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) } : {}),
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Не удалось изменить состояние задачи');
    return body;
  };
  if (action !== 'restart') return request(action === 'start' ? 'running' : 'paused');
  let task = await request();
  if (task.currentExecutions >= task.targetExecutions) throw Error('План уже выполнен. Увеличьте количество выполнений в редакторе задачи.');
  if (task.status === 'running') task = await request('paused');
  const deadline = now() + stopTimeoutMs;
  while (true) {
    // Never resume until every concurrent attempt has acknowledged the pause.
    if (!Array.isArray(task.executions)) throw Error('Не получено состояние попыток. Обновите страницу перед запуском.');
    if (!task.executions.some(execution => execution.status === 'running')) break;
    if (now() >= deadline) throw Error('Остановка ещё выполняется. Задача оставлена на паузе; запустите её после завершения текущих попыток.');
    await wait(Math.min(500, deadline - now()), signal);
    task = await request();
    if (task.status !== 'paused' && task.status !== 'failed') throw Error('Состояние задачи изменилось в другом окне. Обновите страницу.');
  }
  // The existing PATCH preserves progress, scheduling, and retry deadlines.
  return request('running');
}

function pause(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
module.exports = { controlTask };
