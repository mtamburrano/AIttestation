import { Socket } from 'node:net';
import { isAbsolute, resolve, sep } from 'node:path';

const denied = () => Object.assign(Error('FIXTURE_NETWORK_FORBIDDEN'), { code: 'FIXTURE_NETWORK_FORBIDDEN' });

// Install only inside the dedicated fixture worker. Unknown transports fail
// before DNS or connection setup, including accidental real-client fallbacks.
export function restrictFixtureNetwork(root) {
  if (!isAbsolute(root) || resolve(root) !== root) throw denied();
  const sockets = new Set(), ports = new Set(), origins = new Set();
  const connect = Socket.prototype.connect, fetch = globalThis.fetch;
  Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' ? first
      : typeof first === 'string' && !/^\d+$/.test(first) ? { path: first } : { port: first, host: args[1] };
    if (!options || !(options.path ? sockets.has(options.path)
      : options.host === '127.0.0.1' && ports.has(Number(options.port)))) throw denied();
    return connect.apply(this, args);
  };
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!origins.has(url.origin)) return Promise.reject(denied());
    return fetch(input, { ...init, redirect: 'error' });
  };
  return {
    allowRuntime(runtime) {
      const url = new URL(runtime.composerURL);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
          || !runtime.socketPath.startsWith(`${root}${sep}`)) throw denied();
      sockets.add(runtime.socketPath); ports.add(Number(url.port)); origins.add(url.origin);
      return () => { sockets.delete(runtime.socketPath); ports.delete(Number(url.port)); origins.delete(url.origin); };
    },
    restore() { Socket.prototype.connect = connect; globalThis.fetch = fetch; },
  };
}
