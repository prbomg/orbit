import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestCaptchaSolution } from '../worker/captcha-provider.mjs';

const apiKey = 'synthetic-provider-key';
async function withProvider(respond, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    const data = body ? JSON.parse(body) : Object.fromEntries(url.searchParams);
    requests.push({ path: url.pathname, data });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(respond(url.pathname, data, requests.length)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = { captchaBaseUrl: baseUrl, captchaV2BaseUrl: baseUrl, captchaPollingMs: 20, captchaTimeoutMs: 3000 };
  try { await run(config, requests); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

for (const phase of ['create', 'poll']) test(`reCAPTCHA preserves the RuCaptcha SDK error code on ${phase}`, async () => {
  await withProvider(path => path === '/in.php' && phase === 'poll'
    ? { status: 1, request: '12345' } : { status: 0, request: 'ERROR_ZERO_BALANCE' }, async (config, requests) => {
    await assert.rejects(requestCaptchaSolution({ apiKey, type: 'recaptcha',
      params: { googlekey: 'synthetic-sitekey', pageurl: 'https://owned.test/' }, config }), error => {
      assert.equal(error.code, 'ERROR_ZERO_BALANCE');
      assert.ok(!JSON.stringify(error).includes(apiKey));
      return true;
    });
    assert.deepEqual(requests.map(item => item.path), phase === 'create' ? ['/in.php'] : ['/in.php', '/res.php']);
  });
});

test('SmartCaptcha sends the documented image task and preserves coordinate order after processing', async () => {
  const coordinates = [{ x: 300, y: 170 }, { x: 10, y: 20 }];
  await withProvider((path, data, count) => path === '/createTask'
    ? { errorId: 0, taskId: 12345 }
    : count === 2 ? { errorId: 0, status: 'processing' }
      : { errorId: 0, status: 'ready', solution: { coordinates } }, async (config, requests) => {
    assert.deepEqual(await requestCaptchaSolution({ apiKey, type: 'smartcaptcha_image',
      params: { image: 'synthetic-image', imgInstructions: 'synthetic-instruction' }, config }), { coordinates });
    assert.equal(requests[0].data.clientKey, apiKey);
    assert.deepEqual(requests[0].data.task, { type: 'SmartCaptchaTask', image: 'synthetic-image',
      imgInstructions: 'synthetic-instruction', comment: 'Select objects in the order shown by the instruction' });
    assert.deepEqual(requests.map(item => item.path), ['/createTask', '/getTaskResult', '/getTaskResult']);
    assert.equal(requests[2].data.taskId, 12345);
  });
});

test('SmartCaptcha rejects out-of-image coordinates before returning them to the browser', async () => {
  await withProvider(path => path === '/createTask' ? { errorId: 0, taskId: 12345 }
    : { errorId: 0, status: 'ready', solution: { coordinates: [{ x: 320, y: 180 }] } }, async config => {
    await assert.rejects(requestCaptchaSolution({ apiKey, type: 'smartcaptcha_image', params: {}, config }),
      error => error.code === 'INVALID_COORDINATES');
  });
});

test('SmartCaptcha never exposes a provider exception containing a key', async () => {
  await withProvider(() => ({ errorId: 1, errorCode: `https://provider.invalid/?key=${apiKey}` }), async config => {
    await assert.rejects(requestCaptchaSolution({ apiKey, type: 'smartcaptcha', params: {}, config }), error => {
      assert.equal(error.code, 'provider_error');
      assert.ok(!JSON.stringify(error).includes(apiKey));
      return true;
    });
  });
});
