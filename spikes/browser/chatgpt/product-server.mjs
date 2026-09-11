import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BODY_LIMIT = 384 * 1024;

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject); resolve(`http://127.0.0.1:${server.address().port}`);
  });
});

function reply(response, status, value, type = 'application/json') {
  response.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(type === 'application/json' ? JSON.stringify(value) : value);
}

async function requestBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Error('Local composer request limit exceeded');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Invalid local composer request');
  return value;
}

export async function startProductComposer(runtime, { onClose = () => {} } = {}) {
  if (!runtime?.session || typeof runtime.browserState !== 'function') throw Error('Product runtime required');
  const secret = randomBytes(32).toString('base64url');
  let origin, closed = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) throw Error('Local host mismatch');
      const assets = {
        '/': ['product.html', 'text/html; charset=utf-8'],
        '/product-app.js': ['product-app.js', 'text/javascript; charset=utf-8'],
        '/product.css': ['product.css', 'text/css; charset=utf-8'],
      };
      if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
        const [name, type] = assets[request.url];
        return reply(response, 200, await readFile(new URL(name, import.meta.url), 'utf8'), type);
      }
      if (request.method !== 'POST' || request.headers.origin !== origin
          || request.headers.authorization !== `Bearer ${secret}`) throw Error('Unpaired local composer');
      const data = await requestBody(request); let value;
      switch (request.url) {
        case '/status': value = { browser: runtime.browserState(), protection: runtime.session.status() }; break;
        case '/enroll': value = runtime.session.enroll(data); break;
        case '/freeze': value = await runtime.session.freeze(data); break;
        case '/anchor-request': value = runtime.session.anchorRequest(data.id); break;
        case '/confirm': value = await runtime.session.confirmFast(data); break;
        case '/release': value = await runtime.session.release(data); break;
        case '/cancel': value = await runtime.session.cancel(data); break;
        case '/upgrade': value = await runtime.session.upgradeConsensus({
          id: data.id, envelope: Buffer.from(data.envelope, 'base64'), trust: data.trust,
        }); break;
        case '/close':
          reply(response, 200, { closed: true }); setImmediate(() => close()); return;
        default: throw Error('Unsupported local composer operation');
      }
      reply(response, 200, value);
    } catch (error) { reply(response, 400, { error: error.message }); }
  });
  origin = await listen(server);
  const close = async () => {
    if (closed) return; closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await onClose();
  };
  return { origin, url: `${origin}/#${secret}`, close };
}
