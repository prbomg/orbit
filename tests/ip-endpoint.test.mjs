import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../deploy/ip-check.php', import.meta.url));

test('IP endpoint uses the peer address, rejects forged headers, forbids caching and accepts only GET/HEAD', async () => {
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = `http://127.0.0.1:${port}/ip-check.php`;
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', fileURLToPath(new URL('../deploy/', import.meta.url))], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(ready, 'PHP test server must start');
    const response = await fetch(base, { headers: { 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2', Forwarded: 'for=198.51.100.3' } });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ip: '127.0.0.1' });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('set-cookie'), null);
    const head = await fetch(base, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const post = await fetch(base, { method: 'POST' }); assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD');
  } finally {
    const done = new Promise(r => child.once('close', r)); child.kill('SIGTERM'); await done;
  }
});

test('invalid or absent peer addresses are unavailable, IPv6 is returned without client header parsing', async () => {
  const call = async values => JSON.parse((await exec('php', ['-r', '$_SERVER=json_decode($argv[1],true);include $argv[2];', JSON.stringify({ REQUEST_METHOD: 'GET', ...values }), script])).stdout);
  assert.deepEqual(await call({}), { error: 'address_unavailable' });
  assert.deepEqual(await call({ REMOTE_ADDR: 'invalid', HTTP_X_FORWARDED_FOR: '198.51.100.1' }), { error: 'address_unavailable' });
  assert.deepEqual(await call({ REMOTE_ADDR: '2001:db8::1', HTTP_X_FORWARDED_FOR: '198.51.100.1' }), { ip: '2001:db8::1' });
});
