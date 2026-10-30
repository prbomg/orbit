// Test-only preload for suites whose historical fixtures use chromium.launch()
// without an executablePath. Explicit per-test paths always take precedence.
import { chromium } from 'playwright';
const executablePath = process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH;
if (executablePath) {
  const launch = chromium.launch.bind(chromium);
  const persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launch = options => launch({ ...options, executablePath:options?.executablePath||executablePath });
  chromium.launchPersistentContext = (directory, options) => persistent(directory, { ...options, executablePath:options?.executablePath||executablePath });
}
