import { Agent, request } from 'node:http';

const fail = label => Error(`PRIVATE_STOP_${label}`);
const networkFailure = error => fail(error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR'
  ? 'EXIT_TIMED_OUT' : ['EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(error?.code)
    ? 'EXIT_NETWORK_DENIED' : 'EXIT_CONNECTION_FAILED');

export function requestPrivateExit(url) {
  // This bearer belongs only to the numeric loopback endpoint. A dedicated
  // agent must not inherit the CLI's global fetch dispatcher or proxy settings.
  const agent = new Agent({ keepAlive: false, proxyEnv: {} });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); agent.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(fail('EXIT_TIMED_OUT')), 5000);
    let req;
    try {
      req = request({ hostname: '127.0.0.1', port: url.port, path: '/engine/exit', method: 'POST', agent,
        headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}`,
          'Content-Type': 'application/json', 'Content-Length': '2', Connection: 'close' } }, response => {
        if (response.statusCode !== 200) { finish(fail('EXIT_REJECTED')); return; }
        let body = '', length = 0;
        response.on('data', bytes => {
          length += bytes.length;
          if (length > 128) { finish(fail('EXIT_INVALID_RESPONSE')); return; }
          body += bytes.toString('utf8');
        });
        response.once('error', () => finish(fail('EXIT_INVALID_RESPONSE')));
        response.once('aborted', () => finish(fail('EXIT_INVALID_RESPONSE')));
        response.once('end', () => {
          try {
            const value = JSON.parse(body);
            if (!value || Object.keys(value).join(',') !== 'exiting' || value.exiting !== true) throw Error();
            finish(null, 'ACCEPTED');
          } catch { finish(fail('EXIT_INVALID_RESPONSE')); }
        });
      });
      req.once('error', error => {
        // Only a direct refusal proves there is no listener. Socket resets,
        // denied networking and timeouts must leave the locator untouched.
        if (error.code === 'ECONNREFUSED') finish(null, 'ALREADY_EXITED');
        else finish(networkFailure(error));
      });
      req.end('{}');
    } catch (error) { finish(networkFailure(error)); }
  });
}
