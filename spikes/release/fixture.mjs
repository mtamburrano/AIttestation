import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ReleaseRuntime, capabilities, digest } from './runtime.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 700000) throw Error('Body limit'); }
  return JSON.parse(text);
}
function respond(res, status, value, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}

export async function startFixture(directory) {
  const channelKey = randomBytes(32).toString('hex');
  const uiKey = randomBytes(32).toString('hex');
  const egress = [], seen = new Set();
  const adapter = { enabled: true, supported: true, scopes: new Set() };
  let runtime;
  const provider = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(providerOrigin).host) throw Error('Host mismatch');
      if (req.method === 'POST' && req.url === '/release') {
        if (req.headers.authorization !== `Bearer ${channelKey}`) throw Error('Unpaired channel');
        const a = await body(req);
        const durable = runtime.snapshot().attempts[a.attemptId];
        if (!adapter.enabled || !adapter.supported || !adapter.scopes.has(a.scope)) throw Error('Unsupported adapter/scope');
        if (!durable || durable.state !== 'DISPATCHING' || a.protocol !== 'release-fixture/1'
            || durable.sealId !== a.sealId || durable.scope !== a.scope || durable.digest !== a.digest
            || digest(a.payload) !== a.digest || seen.has(a.attemptId)) throw Error('Invalid attempt');
        seen.add(a.attemptId); egress.push(structuredClone(a));
        return respond(res, 200, { observed: true });
      }
      // This deliberately eager page illustrates why provider-owned input is outside Sealed.
      if (req.method === 'POST' && req.url === '/eager') {
        const data = await body(req); egress.push({ unprotected: true, data });
        return respond(res, 200, {});
      }
      if (req.method === 'GET' && req.url === '/') return respond(res, 200,
        '<!doctype html><meta charset="utf-8"><title>Synthetic provider</title><h1>Synthetic provider</h1><p>Unprotected provider-owned input: drafts and attachments leave immediately.</p><textarea id="draft"></textarea><input id="upload" type="file"><pre id="response"></pre><script src="/provider.js"></script>', 'text/html');
      if (req.url === '/provider.js') return respond(res, 200,
        `const send = data => fetch('/eager',{method:'POST',body:JSON.stringify(data)}); document.querySelector('#draft').oninput = e => send({draft:e.target.value}); document.querySelector('#upload').onchange = async e => { for (const f of e.target.files) await send({name:f.name,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}); }; fetch('/visible').then(r=>r.json()).then(v=>document.querySelector('#response').textContent=v.text);`, 'text/javascript');
      if (req.url === '/visible') return respond(res, 200, { text: egress.filter(a => !a.unprotected).map(a => `Observed synthetic submission: ${a.payload.text}`).join('\n') });
      respond(res, 404, {});
    } catch (e) { respond(res, 400, { error: e.message }); }
  });
  const providerOrigin = await listen(provider);
  const dispatch = async a => {
    if (!adapter.enabled || !adapter.supported || !adapter.scopes.has(a.scope)) return 'FAILED_BEFORE_EGRESS';
    const response = await fetch(`${providerOrigin}/release`, { method: 'POST',
      headers: { Authorization: `Bearer ${channelKey}` }, body: JSON.stringify(a) });
    return response.ok ? 'SUBMISSION_OBSERVED' : 'OUTCOME_UNKNOWN';
  };
  runtime = await new ReleaseRuntime(directory, dispatch).init();
  const composer = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(composerOrigin).host) throw Error('Host mismatch');
      if (req.method === 'GET' && req.url === '/') return respond(res, 200,
        await readFile(new URL('./composer.html', import.meta.url), 'utf8'), 'text/html');
      if (req.method === 'GET' && req.url === '/composer.js') return respond(res, 200,
        await readFile(new URL('./composer.js', import.meta.url), 'utf8'), 'text/javascript');
      if (req.method !== 'POST' || req.headers.origin !== composerOrigin
          || req.headers.authorization !== `Bearer ${uiKey}`) throw Error('Unpaired local UI');
      const data = await body(req);
      let value;
      switch (req.url) {
        case '/scope': adapter.scopes.add(data.scope); value = { capabilities, providerOrigin }; break;
        case '/seal': value = await runtime.seal(data.payload, data.scope); break;
        case '/confirm': value = await runtime.confirm(data.id, data.scope, data.expectedDigest); break;
        case '/release': value = await runtime.release(data); break;
        case '/retry': value = await runtime.retry(data.id, data.scope, data.priorAttempt, data.explicit); break;
        default: throw Error('Unsupported operation');
      }
      respond(res, 200, value ?? {});
    } catch (e) { respond(res, 400, { error: e.message }); }
  });
  const composerOrigin = await listen(composer);
  return { url: `${composerOrigin}/#${uiKey}`, composerOrigin, providerOrigin, adapter, egress,
    runtime: () => runtime,
    restart: async () => { adapter.scopes.clear(); runtime = await new ReleaseRuntime(directory, dispatch).init(); },
    close: async () => { await close(composer); await close(provider); } };
}
