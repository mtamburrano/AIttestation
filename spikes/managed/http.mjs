import { createServer } from 'node:http';
import { canonical, parseCanonical } from '../vault/format.mjs';
import { FALLBACK } from './protocol.mjs';

export async function startManagedServer(service, { port = 0 } = {}) {
  let active = 0;
  const pending = new Set();
  const reply = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Connection': 'close' });
    response.end(canonical(body));
  };
  const server = createServer({ maxHeaderSize: 2048, requestTimeout: 10000, headersTimeout: 5000 }, (request, response) => {
    const operation = (async () => {
      if (active >= 16) { reply(response, 503, { error: 'SERVICE_UNAVAILABLE' }); return; }
      active++;
      const deadline = setTimeout(() => request.destroy(), 10000);
      try {
        if (request.headers.origin || request.headers['transfer-encoding']
            || !['GET /v1/account', 'POST /v1/anchors'].includes(`${request.method} ${request.url}`)) {
          reply(response, 400, { error: 'INVALID_REQUEST' }); return;
        }
        const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        if (request.method === 'GET') {
          if (request.headers['content-length'] && request.headers['content-length'] !== '0') throw Error('Unexpected body');
          reply(response, 200, service.account(token)); return;
        }
        if (request.headers['content-type'] !== 'application/json' || !/^[1-9][0-9]{0,2}$/.test(request.headers['content-length'] ?? '')
            || Number(request.headers['content-length']) > 256) throw Error('Invalid request bounds');
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length; if (size > 256) throw Error('Request too large'); chunks.push(chunk);
        }
        const body = parseCanonical(Buffer.concat(chunks), 256);
        reply(response, 200, await service.anchor(token, body));
      } catch (error) {
        const code = Object.hasOwn(FALLBACK, error.code ?? '') ? error.code : 'INVALID_REQUEST';
        const status = { ACCOUNT_REQUIRED: 401, UNPAID: 402, QUOTA_EXHAUSTED: 429, RATE_LIMITED: 429,
          SERVICE_UNAVAILABLE: 503, SUBMISSION_INTERRUPTED: 409 }[code] ?? 400;
        if (!response.destroyed) reply(response, status, { error: code });
      } finally { clearTimeout(deadline); active--; }
    })();
    pending.add(operation); operation.finally(() => pending.delete(operation));
  });
  server.maxConnections = 32; server.maxRequestsPerSocket = 1;
  server.setTimeout(10000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await Promise.allSettled([...pending]);
    } };
}
