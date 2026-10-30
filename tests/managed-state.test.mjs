import test from 'node:test';
import assert from 'node:assert/strict';
import { managedEventRecord } from '../worker/managed-state.mjs';

test('failure diagnostics survive a blocked process stopping', () => {
  for (const code of ['image_capture_failed', 'solve_limit', 'captcha_reload_failed', 'checkbox_not_completed', 'checkbox_navigation_timeout']) {
    const failed = managedEventRecord({ event: 'session_started' }, 'session_failed', { errorType: 'CaptchaError', code });
    const blocked = managedEventRecord(failed, 'project_blocked', { errorType: 'CaptchaError', code });
    const stopped = managedEventRecord(blocked, 'worker_stopped');
    assert.equal(stopped.event, 'project_blocked');
    assert.equal(stopped.errorType, 'CaptchaError');
    assert.equal(stopped.errorCode, code);
  }
});

test('an unknown failure cannot leak data or keep a previous error code', () => {
  const next = managedEventRecord({ errorCode: 'image_capture_failed', providerCode: 'invalid_api_key' },
    'worker_error', { errorType: 'Error', code: 'https://example.test/?secret=value', providerCode: 'secret' });
  assert.equal(next.errorCode, null);
  assert.equal(next.providerCode, null);
});

test('a new session clears the previous failure', () => {
  const next = managedEventRecord({ errorType: 'CaptchaError', errorCode: 'image_capture_failed', providerCode: 'invalid_api_key' }, 'session_started');
  assert.equal(next.errorType, null);
  assert.equal(next.errorCode, null);
  assert.equal(next.providerCode, null);
});

test('search preparation failures keep a specific safe diagnostic code', () => {
  for (const code of ['search_input_not_found', 'search_input_activation_timeout', 'search_input_typing_timeout', 'search_submit_timeout', 'search_results_timeout', 'search_query_mismatch', 'search_overlay_blocked', 'search_navigation_unstable']) {
    const next = managedEventRecord({}, 'session_failed', { errorType: 'SearchError', code });
    assert.equal(next.errorType, 'SearchError');
    assert.equal(next.errorCode, code);
  }
});
