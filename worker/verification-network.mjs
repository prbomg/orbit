import { createServer } from 'node:http';

// A context's offline flag is applied after Chromium starts. A private rejecting
// proxy blocks browser-process/SW/startup traffic before any target attaches.
// No production proxy credentials or requests enter this verification process.
export async function isolateVerificationNetwork(launchOptions = {}) {
 const sockets = new Set();
 const server = createServer((_request, response) => { response.writeHead(502, {'Connection':'close'}); response.end(); });
 server.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
 server.on('clientError', (_error, socket) => socket.destroy());
 server.on('connection', socket => { socket.on('error', () => socket.destroy()); sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 const proxy = { server: `http://127.0.0.1:${server.address().port}` };
 const args = (launchOptions.args || []).filter(arg => !/^--(?:proxy-server|proxy-bypass-list|proxy-pac-url|no-proxy-server|proxy-auto-detect)(?:=|$)/.test(arg));
 return { options: {...launchOptions, args, proxy}, close: async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
 } };
}

