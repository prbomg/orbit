import { inspectContextMatrix } from './context-matrix.mjs';

const baselines = new WeakMap();
// Cache belongs to the live Browser, never just to its version. The baseline
// excludes Orbit profile scripts; browser-wide launch flags/plugins still apply.
// The standalone CLI uses an additional vanilla browser for a stricter baseline.
export async function readNativeBaseline(browser) {
  if (!browser) return { status: 'failed', scope: 'unavailable', records: [], error: 'baseline_browser_unavailable' };
  if (!baselines.has(browser)) {
    const promise = (async () => {
      const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 360, height: 780 }, serviceWorkers: 'allow' });
      try {
        const matrix = await inspectContextMatrix(await context.newPage(), null, { native: true });
        return { ...matrix, status: matrix.apiBehavior.errors ? 'failed' : matrix.status,
          runtimeVersion: browser.version(), scope: 'same-browser-without-orbit-profile-scripts' };
      } finally { await context.close(); }
    })();
    baselines.set(browser, promise);
  }
  try {
    const baseline = await baselines.get(browser);
    if (baseline.status !== 'passed') baselines.delete(browser);
    return baseline;
  } catch {
    baselines.delete(browser);
    return { status: 'failed', scope: 'same-browser-without-orbit-profile-scripts', records: [], error: 'baseline_probe_failed' };
  }
}

// This capability trial operates only on an isolated synthetic page/worker.
// A successful CDP command does not imply propagation into child contexts.
export async function inspectNativeCpuOverride(browser) {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Orbit CPU capability</title>' }));
    const page = await context.newPage();
    await page.goto('https://orbit-cpu.invalid/');
    const before = await page.evaluate(() => navigator.hardwareConcurrency);
    const requested = before === 7 ? 6 : 7;
    const session = await context.newCDPSession(page);
    try {
      await session.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: requested });
      const observed = await page.evaluate(() => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob(['postMessage(navigator.hardwareConcurrency)'], { type: 'application/javascript' }));
        const worker = new Worker(url);
        const finish = action => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); action(); };
        const timer = setTimeout(() => finish(() => reject(Error('cpu_probe_timeout'))), 3000);
        worker.onmessage = e => finish(() => resolve({ main: navigator.hardwareConcurrency, dedicatedWorker: e.data }));
        worker.onerror = () => finish(() => reject(Error('cpu_probe_failed')));
      }));
      return { status: 'measured', command: 'Emulation.setHardwareConcurrencyOverride', before, requested, observed,
        safeToReplaceAllCpuWrappers: false,
        reason: observed.main === requested && observed.dedicatedWorker === requested ? 'shared_and_service_workers_not_qualified' : 'override_does_not_cover_tested_contexts' };
    } finally { await session.detach().catch(() => {}); }
  } catch {
    return { status: 'error', command: 'Emulation.setHardwareConcurrencyOverride', safeToReplaceAllCpuWrappers: false, reason: 'native_cpu_probe_failed_or_unsupported' };
  } finally { await context.close(); }
}
