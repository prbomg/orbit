import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TaskStoppedError } from './behavior.mjs';

export class CaptchaError extends Error {
  constructor(code) { super('Captcha handling failed'); this.name = 'CaptchaError'; this.code = code; }
}

export async function requestCaptchaSolution({ apiKey, type, params, config, signal, shouldContinue = async () => true }) {
  signal?.throwIfAborted();
  if (!apiKey) throw new CaptchaError('missing_api_key');
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./captcha-client.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    let finished = false; let checking = false;
    const finish = (error, solution) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      child.kill();
      error ? reject(error) : resolve(solution);
    };
    const abort = () => finish(signal.reason ?? new CaptchaError('aborted'));
    const timeout = setTimeout(() => finish(new CaptchaError('timeout')), config.captchaTimeoutMs);
    const heartbeat = setInterval(async () => {
      if (checking || finished) return;
      checking = true;
      try { if (!(await shouldContinue())) finish(new TaskStoppedError()); }
      catch { finish(new CaptchaError('task_check_failed')); }
      finally { checking = false; }
    }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.once('error', () => finish(new CaptchaError('client_start_failed')));
    child.once('exit', () => { if (!finished) finish(new CaptchaError('client_exited')); });
    child.once('message', message => {
      if (message.ok && message.solution && typeof message.solution === 'object') finish(null, message.solution);
      else finish(new CaptchaError(message.code ?? 'provider_error'));
    });
    // Keys and tokens travel over IPC, never command-line arguments or console output.
    child.send({ apiKey, baseUrl: config.captchaBaseUrl, v2BaseUrl: config.captchaV2BaseUrl ?? config.captchaBaseUrl, pollingMs: config.captchaPollingMs, type, params }, error => {
      if (error) finish(new CaptchaError('client_start_failed'));
    });
  });
}

export async function requestCaptchaToken(options) {
  const solution = await requestCaptchaSolution(options);
  if (typeof solution.token !== 'string' || !solution.token) throw new CaptchaError('invalid_token');
  return solution.token;
}
