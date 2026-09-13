import { request } from 'node:https';
import { canonical, parseCanonical } from '../vault/format.mjs';
import { managedError, TOKEN_PATTERN } from '../managed/protocol.mjs';

// Only the private build imports this transport. Trust is the exact local
// certificate copied before signing; no global CA or TLS environment override.
export function localTLSRequest(certificate, pinnedOrigin) {
  if (!Buffer.isBuffer(certificate) || !/^https:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(pinnedOrigin)
      || new URL(pinnedOrigin).origin !== pinnedOrigin) throw Error('EXPLICIT_LOCAL_TLS_SPONSOR_REQUIRED');
  return (origin, path, token, body) => new Promise((resolve, reject) => {
    if (origin !== pinnedOrigin || !['/v1/account', '/v1/anchors'].includes(path) || !TOKEN_PATTERN.test(token)
        || (path === '/v1/account') !== (body === undefined)) {
      reject(managedError('SERVICE_UNAVAILABLE')); return;
    }
    const bytes = body === undefined ? null : Buffer.from(canonical(body));
    if (bytes?.length > 256) { reject(managedError('SERVICE_UNAVAILABLE')); return; }
    const req = request(new URL(path, origin), { ca: certificate, rejectUnauthorized: true, agent: false,
      method: bytes ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`,
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } });
    const deadline = setTimeout(() => req.destroy(), 12000);
    const fail = () => { clearTimeout(deadline); reject(managedError('SERVICE_UNAVAILABLE')); };
    req.once('error', fail);
    req.once('response', response => {
      let size = 0; const chunks = [];
      if (response.statusCode >= 300 && response.statusCode < 400) { req.destroy(); fail(); return; }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) { req.destroy(); fail(); } else chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('end', () => {
        clearTimeout(deadline);
        try {
          const result = parseCanonical(Buffer.concat(chunks), 4096);
          if (response.statusCode !== 200) throw managedError(result.error);
          resolve(result);
        } catch (error) { reject(managedError(error.code)); }
      });
    });
    req.end(bytes);
  });
}
