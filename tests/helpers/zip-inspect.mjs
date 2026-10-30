import { spawn } from 'node:child_process';

// Independent standard-library reader: verify CRCs and extracted bytes, not just
// our writer's headers. Fixtures are small; production never buffers ZIPs.
export function inspectZip(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', `
import sys, io, zipfile, base64, json
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    print(json.dumps({item.filename: {
        "directory": item.is_dir(),
        "mode": item.external_attr >> 16,
        "content": base64.b64encode(archive.read(item)).decode()
    } for item in archive.infolist()}))
`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ZIP reader exited ${code}: ${error}`));
      try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); }
    });
    child.stdin.end(bytes);
  });
}
