import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DemoSession } from './session.mjs';
import { digest } from '../release/runtime.mjs';
import { verifyBundle } from './verification.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
function reply(res, status, value, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors ${res.frameAncestor ?? "'none'"}; base-uri 'none'; form-action 'none'` });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw Error('Import limit: 16 MiB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startDemo(directory, { onClose = () => {}, onReady = () => {} } = {}) {
  const uiKey = randomBytes(32).toString('hex'), channel = randomBytes(32).toString('hex');
  const egress = new Map(); let session, appOrigin, providerOrigin;
  const provider = createServer(async (req, res) => {
    res.frameAncestor = appOrigin ?? "'none'";
    try {
      if (req.headers.host !== new URL(providerOrigin).host) throw Error('Host mismatch');
      if (req.method === 'GET' && new URL(req.url, providerOrigin).pathname === '/') return reply(res, 200,
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic provider</title><h2>Synthetic provider</h2><p>Loopback fixture. No external AI service.</p><pre id="response">No submission observed.</pre><script src="/provider.js"></script></html>', 'text/html');
      if (req.method === 'GET' && req.url === '/provider.js') return reply(res, 200,
        `const [key,attemptId]=location.hash.slice(1).split('/'); history.replaceState(null,'','/'); if(attemptId) fetch('/visible',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({attemptId})}).then(r=>{if(!r.ok)throw Error('Unavailable');return r.json()}).then(v=>{document.querySelector('#response').textContent=v.text;parent.postMessage({kind:'synthetic-visible',attemptId,text:document.querySelector('#response').textContent},${JSON.stringify(appOrigin)})}).catch(()=>document.querySelector('#response').textContent='Response unavailable');`, 'text/javascript');
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${channel}`) throw Error('Unpaired provider channel');
      const data = await body(req);
      if (req.url === '/visible') {
        const attempt = egress.get(data.attemptId); if (!attempt) throw Error('Unknown attempt');
        return reply(res, 200, { text: `Synthetic visible response: ${attempt.payload.text}\nAttachments observed: ${attempt.payload.attachments.length}` });
      }
      if (req.url !== '/release') throw Error('Unsupported operation');
      const version = session.status().versions.find(v => v.id === data.sealId);
      if (!version || version.scope !== data.scope || version.digest !== digest(data.payload) || egress.has(data.attemptId)) throw Error('Invalid version/attempt');
      if (!data.continuous) {
        const durable = session.runtime.snapshot().attempts[data.attemptId];
        if (!durable || durable.state !== 'DISPATCHING' || durable.digest !== version.digest || durable.scope !== data.scope) throw Error('No durable authorization');
      } else if (version.mode !== 'Continuous') throw Error('Mode mismatch');
      egress.set(data.attemptId, data); return reply(res, 200, { observed: true });
    } catch (e) { reply(res, 400, { error: e.message }); }
  });
  const app = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(appOrigin).host) throw Error('Host mismatch');
      const assets = { '/': ['app.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
        const [name, type] = assets[req.url]; return reply(res, 200, await readFile(new URL(name, import.meta.url), 'utf8'), type);
      }
      if (req.method !== 'POST' || req.headers.origin !== appOrigin || req.headers.authorization !== `Bearer ${uiKey}`) throw Error('Unpaired local UI');
      const data = await body(req); let value;
      switch (req.url) {
        case '/ready': await onReady(); value = { ready: true }; break;
        case '/enroll': value = { ...session.enroll(data.scope, data.policy, data.trust), providerOrigin }; break;
        case '/freeze': value = await session.freeze(data); break;
        case '/confirm': value = await session.confirm(data); break;
        case '/release': value = await session.release(data); value.providerURL = `${providerOrigin}/?view=${value.attempt.attemptId}#${channel}/${value.attempt.attemptId}`; break;
        case '/capture': value = await session.captureVisible(data); break;
        case '/anchor-request': value = session.anchorRequest(data.id); break;
        case '/export': value = session.exportDisclosure(); break;
        case '/recovery': value = session.exportRecovery(); break;
        case '/restore': value = session.restore(data.package, data.recoveryKey); break;
        case '/verify': value = verifyBundle(data.bundle, data.trust); break;
        case '/status': value = session.status(); break;
        case '/close': reply(res, 200, {}); setImmediate(() => close()); return;
        default: throw Error('Unsupported operation');
      }
      reply(res, 200, value);
    } catch (e) { reply(res, 400, { error: e.message }); }
  });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await stop(app); await session?.drain(); await stop(provider); session?.close(); onClose();
  };
  try {
    providerOrigin = await listen(provider);
    session = await new DemoSession(directory, async a => {
      const r = await fetch(`${providerOrigin}/release`, { method: 'POST', headers: { Authorization: `Bearer ${channel}` }, body: JSON.stringify(a) });
      return r.ok ? 'SUBMISSION_OBSERVED' : 'OUTCOME_UNKNOWN';
    }).init();
    appOrigin = await listen(app);
    return { url: `${appOrigin}/#${uiKey}`, appOrigin, providerOrigin, session, egress, close };
  } catch (e) { await close(); throw e; }
}
