import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RECIPIENT_LIMITS } from './portable.mjs';

export function verifyIsolated(bundle, trust = null) {
  if (typeof bundle !== 'string' || Buffer.byteLength(bundle) > RECIPIENT_LIMITS.wire
      || (trust !== null && (typeof trust !== 'string' || Buffer.byteLength(trust) > RECIPIENT_LIMITS.trust))) throw Error('Input size limit');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('verify.mjs', import.meta.url)), '--stdin'],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', exceeded = false;
    const stop = () => { exceeded = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 30000);
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 2 * 2 ** 20) stop(); });
    child.stderr.on('data', chunk => { errors += chunk; if (Buffer.byteLength(errors) > 65536) stop(); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (exceeded || (code !== 0 && code !== 2)) return reject(Error(exceeded ? 'Verification resource limit' : errors || 'Verifier unavailable'));
      try { resolve(JSON.parse(output)); } catch { reject(Error('Invalid verifier response')); }
    });
    child.stdin.end(JSON.stringify({ bundle, trust }));
  });
}

export async function startRecipient() {
  const token = randomBytes(32).toString('base64url'); let origin, busy = false;
  const server = createServer(async (request, response) => {
    const reply = (status, value, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      if (request.headers.host !== new URL(origin).host) throw Error('Local host mismatch');
      const assets = { '/': ['recipient.html', 'text/html; charset=utf-8'],
        '/recipient.js': ['recipient.js', 'text/javascript; charset=utf-8'], '/recipient.css': ['recipient.css', 'text/css; charset=utf-8'] };
      if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
        const [name, type] = assets[request.url]; return reply(200, await readFile(new URL(name, import.meta.url)), type);
      }
      if (request.method !== 'POST' || request.headers.origin !== origin
          || request.headers.authorization !== `Bearer ${token}`) throw Error('Unpaired recipient page');
      if (request.url === '/close') { reply(200, { closed: true }); setImmediate(() => server.close()); return; }
      if (request.url !== '/verify' || busy) throw Error('Verifier busy or unsupported operation');
      busy = true;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length; if (size > 2 * RECIPIENT_LIMITS.wire + RECIPIENT_LIMITS.trust) throw Error('Input size limit');
          chunks.push(chunk);
        }
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        reply(200, await verifyIsolated(data.bundle, data.trust));
      } finally { busy = false; }
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.requestTimeout = 35000; server.headersTimeout = 5000; server.maxConnections = 4;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}/#${token}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
