// CommonJS entry point; the implementation stays in ES modules.
import('./index.mjs').catch(() => {
  console.error(JSON.stringify({ event: 'startup_failed', errorType: 'ModuleLoadError' }));
  process.exitCode = 1;
});
