import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dashboardState } from './dashboard.mjs';

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
    if (size > limit) throw Error('Local dashboard request limit exceeded');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Invalid local dashboard request');
  return value;
}

export async function startProductDashboard(runtime, { onClose = () => {}, onExit = null } = {}) {
  if (!runtime?.session || typeof runtime.browserState !== 'function') throw Error('Product runtime required');
  const secret = randomBytes(32).toString('base64url');
  let origin, closed = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) throw Error('Local host mismatch');
      const assets = {
        '/': ['dashboard.html', 'text/html; charset=utf-8'],
        '/dashboard': ['dashboard.html', 'text/html; charset=utf-8'],
        '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
        '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
      };
      const pathname = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && Object.hasOwn(assets, pathname)) {
        const [name, type] = assets[pathname];
        return reply(response, 200, await readFile(new URL(name, import.meta.url), 'utf8'), type);
      }
      if (request.method !== 'POST' || request.headers.origin !== origin
          || request.headers.authorization !== `Bearer ${secret}`) throw Error('Unpaired local dashboard');
      const data = await requestBody(request, request.url === '/upgrade' ? 12 * 1024 * 1024 : BODY_LIMIT); let value;
      if (request.url.startsWith('/debug-session/')) {
        try {
          if (!runtime.debugSession) throw Error('Private debug session unavailable');
          if (request.url === '/debug-session/recording' && Object.keys(data).join(',') === 'enabled') {
            return reply(response, 200, runtime.debugSession.setEnabled(data.enabled));
          }
          if (request.url === '/debug-session/export' && !Object.keys(data).length) {
            return reply(response, 200, { content: runtime.debugSession.export() });
          }
          if (request.url === '/debug-session/new') {
            return reply(response, 200, runtime.debugSession.startFresh(data));
          }
          throw Error('Unsupported private debug action');
        } catch { return reply(response, 400, { error: request.url === '/debug-session/new'
          ? 'Fresh session could not be confirmed. Refresh, pause debug recording and acknowledge the current session before trying again. Unsafe journals are not repaired.'
          : 'Private debug recording is unavailable. Existing journal files have been left in place.' }); }
      }
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
          '/installation/remove': 'remove', '/installation/disable': 'disable', '/installation/diagnostics': 'diagnostics',
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
        case '/dashboard/state':
          if (Object.keys(data).some(key => !['attentionOnly', 'offset'].includes(key))) throw Error('Invalid dashboard request');
          value = await dashboardState(runtime, data); break;
        case '/dashboard/command': value = await runtime.engine.command(data, { surface: 'desktop' }); break;
        case '/dashboard/verifier':
          if (Object.keys(data).length || !runtime.openVerifier) throw Error('Verifier unavailable');
          value = await runtime.openVerifier(); break;
        case '/dashboard/recovery': {
          if (Object.keys(data).join(',') !== 'confirmed' || data.confirmed !== true) throw Error('Recovery consent required');
          const recovery = runtime.session.vault.exportRecovery();
          try { value = { package: recovery.package.toString('utf8'), recoveryKey: recovery.recoveryKey.toString('base64') }; }
          finally { recovery.recoveryKey.fill(0); }
          break;
        }
        case '/status': value = { browser: runtime.browserState(), recording: runtime.session.status() }; break;
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
        case '/anchor-request': value = runtime.session.anchorRequest(data.id); break;
        case '/confirm': value = await runtime.session.confirmFast(data); break;
        case '/upgrade': value = await runtime.session.upgradeConsensus({
          id: data.id, envelope: Buffer.from(data.envelope, 'base64'), trust: data.trust,
        }); break;
        case '/close':
          value = { closed: true, engine: 'RUNNING' }; break;
        default: throw Error('Unsupported local dashboard operation');
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
  return { origin, url: `${origin}/#${secret}`, dashboardURL: `${origin}/dashboard#${secret}`, close };
}
