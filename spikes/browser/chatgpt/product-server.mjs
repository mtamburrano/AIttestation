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

async function requestBody(request, limit = BODY_LIMIT) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Error('Local composer request limit exceeded');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Invalid local composer request');
  return value;
}

export async function startProductComposer(runtime, { onClose = () => {}, onExit = null } = {}) {
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
      const data = await requestBody(request, request.url === '/upgrade' ? 12 * 1024 * 1024 : BODY_LIMIT); let value;
      if (request.url.startsWith('/diagnostics/')) {
        try {
          if (!runtime.diagnostics) throw Error('Diagnostics unavailable');
          if (request.url === '/diagnostics/selection' && Object.keys(data).length === 0) {
            return reply(response, 200, runtime.diagnostics.selection());
          }
          if (request.url === '/diagnostics/preview') return reply(response, 200, runtime.diagnostics.preview(data));
          if (request.url === '/diagnostics/export' && Object.keys(data).join(',') === 'previewId') {
            return reply(response, 200, { content: runtime.diagnostics.export(data.previewId) });
          }
          throw Error('Unsupported diagnostic operation');
        } catch { return reply(response, 400, { error: 'Diagnostic selection expired or is invalid. Preview again before saving.' }); }
      }
      if (request.url.startsWith('/installation/')) {
        const operations = { '/installation/status': 'status', '/installation/enable': 'enable',
          '/installation/store': 'store', '/installation/export-opportunity': 'offerExport',
          '/installation/remove': 'remove', '/installation/diagnostics': 'diagnostics',
          '/installation/check-update': 'checkUpdate', '/installation/download-update': 'downloadUpdate' };
        const operation = operations[request.url];
        if (!operation) throw Error('Unsupported installation operation');
        if (!runtime.maintenance) {
          if (operation === 'status') return reply(response, 200, { integration: 'NOT_CONFIGURED', storeURL: null, releaseChannel: null, releaseClass: 'DEVELOPMENT' });
          throw Error('Signed distribution is not configured in this build');
        }
        try { return reply(response, 200, await runtime.maintenance[operation](data)); }
        catch { return reply(response, 400, { error: 'Installation action could not complete. Evidence has been retained. Restart the app or save the content-free support report.' }); }
      }
      switch (request.url) {
        case '/status': value = { browser: runtime.browserState(), protection: runtime.session.status() }; break;
        case '/engine/state':
          if (Object.keys(data).length) throw Error('Invalid state request');
          value = runtime.engine.state(); break;
        case '/engine/command': value = await runtime.engine.command(data, { surface: 'development' }); break;
        case '/engine/exit':
          if (Object.keys(data).length || !onExit) throw Error('Engine exit unavailable');
          reply(response, 200, { exiting: true }); setImmediate(() => onExit()); return;
        case '/managed/status': value = await runtime.session.managedStatus(); break;
        case '/managed/connect': value = await runtime.session.connectManaged(data); break;
        case '/managed/disconnect': value = runtime.session.disconnectManaged(); break;
        case '/managed/anchor': value = await runtime.session.anchorManaged(data); break;
        case '/receipts': value = runtime.session.receipts.list(); break;
        case '/receipts/preview': value = runtime.session.receipts.prepare(data); break;
        case '/receipts/export': value = { content: runtime.session.receipts.export(data.previewId).toString('utf8') }; break;
        case '/receipts/redact': value = runtime.session.receipts.redact(data); break;
        case '/enroll': value = runtime.session.enroll(data); break;
        case '/draft': value = runtime.session.updateDraft(data); break;
        case '/freeze': value = await runtime.session.freeze(data); break;
        case '/anchor-request': value = runtime.session.anchorRequest(data.id); break;
        case '/confirm': value = await runtime.session.confirmFast(data); break;
        case '/release': value = await runtime.session.release(data); break;
        case '/cancel': value = await runtime.session.cancel(data); break;
        case '/upgrade': value = await runtime.session.upgradeConsensus({
          id: data.id, envelope: Buffer.from(data.envelope, 'base64'), trust: data.trust,
        }); break;
        case '/close':
          value = { closed: true, engine: 'RUNNING' }; break;
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
