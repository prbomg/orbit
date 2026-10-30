import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const port = Number(process.env.ORBIT_ENTRY_LAB_PORT || 8081);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ORBIT_ENTRY_LAB_PORT');
const html = await readFile(new URL('../tests/fixtures/search-entry-lab.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.method !== 'GET' || !['/', '/search-entry-lab'].includes(request.url)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html);
});
server.requestTimeout = 5000; server.headersTimeout = 5000;
server.listen(port, '127.0.0.1', () => console.log(`Search entry lab: http://127.0.0.1:${port}/`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
