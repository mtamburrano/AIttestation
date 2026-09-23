import { Agent, request } from 'node:http';
import { validateRuntimeState, RUNTIME_STATE_PROFILE } from './runtime-state.mjs';

// Use a dedicated direct connection: dashboard capabilities must never reach
// an inherited proxy, redirect, or caller-selected non-loopback destination.
export function agentRequest(locator, path, body = {}, { timeoutMs = 5000, requestHTTP = request } = {}) {
  const url = new URL(validateRuntimeState({ profile: RUNTIME_STATE_PROFILE, dashboardURL: locator }).dashboardURL);
  if (!/^\/[a-z-]+\/[a-z-]+$/.test(path)) throw Error('AGENT_COMMAND_INVALID');
  const bytes = JSON.stringify(body);
  if (Buffer.byteLength(bytes) > 4096) throw Error('AGENT_COMMAND_INVALID');
  const agent = new Agent({ keepAlive: false, proxyEnv: {} });
  return new Promise((resolve, reject) => {
    let req, settled = false;
    const finish = (reason, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); req?.destroy(); agent.destroy();
      if (reason) reject(Error(reason)); else resolve(value);
    };
    const timer = setTimeout(() => finish('AGENT_API_TIMED_OUT'), timeoutMs);
    try {
      req = requestHTTP({ hostname: '127.0.0.1', port: url.port, path, method: 'POST', agent,
        headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}`,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes), Connection: 'close' } }, response => {
        if (response.statusCode !== 200) return finish('AGENT_API_REJECTED');
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) return finish('AGENT_API_LIMIT');
          chunks.push(chunk);
        });
        response.once('error', () => finish('AGENT_API_UNAVAILABLE'));
        response.once('aborted', () => finish('AGENT_API_UNAVAILABLE'));
        response.once('end', () => {
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish('AGENT_API_INVALID'); }
        });
      });
      req.once('error', () => finish('AGENT_API_UNAVAILABLE'));
      req.end(bytes);
    } catch { finish('AGENT_API_UNAVAILABLE'); }
  });
}
