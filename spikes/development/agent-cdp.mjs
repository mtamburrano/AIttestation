import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readReleaseFile } from '../distribution/release-inputs.mjs';
import { exists, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';
import { launchDevelopmentChrome, runningChromeProcesses } from './chrome.mjs';
import { closeAgentBrowser } from './agent-process.mjs';

const CDP_PROFILE = 'pap-agent-cdp/1';
export function validateAgentCDP(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'pid,profile,webSocketDebuggerUrl'
      || value.profile !== CDP_PROFILE || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.webSocketDebuggerUrl !== 'string'
      || !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/browser\/[a-zA-Z0-9-]{1,80}$/.test(value.webSocketDebuggerUrl)) {
    throw Error('AGENT_CDP_INVALID');
  }
  new URL(value.webSocketDebuggerUrl);
  return value;
}

export async function launchAgentChrome(chrome, paths, {
  spawnProcess = spawn, processes = runningChromeProcesses, launch = launchDevelopmentChrome, wait = delay,
} = {}) {
  await ownerDirectory(paths.root); await ownerDirectory(paths.chrome); await ownerDirectory(paths.control);
  if (paths.chrome !== join(paths.root, 'chrome') || chrome.application !== paths.chromeApplication
      || processes().length) throw Error('CLOSE_OTHER_CHROME_COPY');
  const activePort = join(paths.chrome, 'DevToolsActivePort'), metadata = join(paths.control, 'cdp.json');
  if (await exists(metadata)) throw Error('AGENT_CDP_STALE');
  if (await exists(activePort)) {
    await readReleaseFile(activePort, { limit: 256 });
    await unlink(activePort);
  }
  let child;
  try {
    const result = await launch(chrome, paths, 'about:blank', { runningProcesses: processes,
      spawnProcess: (command, args, options) => {
        child = spawnProcess(command, [...args.slice(0, -1), '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0', args.at(-1)], options);
        return child;
      } });
    if (result.pid !== child?.pid) throw Error('AGENT_CDP_INVALID');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode) throw Error('AGENT_CDP_UNAVAILABLE');
      if (await exists(activePort)) {
        const text = await readReleaseFile(activePort, { limit: 256 });
        const match = /^([1-9][0-9]{0,4})\n(\/devtools\/browser\/[a-zA-Z0-9-]{1,80})\n?$/.exec(text.toString());
        if (!match || Number(match[1]) > 65535) throw Error('AGENT_CDP_INVALID');
        const value = validateAgentCDP({ profile: CDP_PROFILE, pid: child.pid,
          webSocketDebuggerUrl: `ws://127.0.0.1:${match[1]}${match[2]}` });
        await writeNewJSON(metadata, value);
        return { child, metadata, value, async close() {
          await closeAgentBrowser(child);
          if (await exists(metadata)) {
            const current = validateAgentCDP(await privateJSON(metadata));
            if (JSON.stringify(current) !== JSON.stringify(value)) throw Error('AGENT_CDP_CHANGED');
            await unlink(metadata);
          }
        } };
      }
      await wait(100);
    }
    throw Error('AGENT_CDP_TIMED_OUT');
  } catch (error) {
    await closeAgentBrowser(child).catch(() => {});
    throw error;
  }
}

export async function connectAgentCDP(value, { WebSocketClass = WebSocket, timeoutMs = 5000, onEvent = () => {} } = {}) {
  const endpoint = validateAgentCDP(value).webSocketDebuggerUrl;
  const socket = new WebSocketClass(endpoint), pending = new Map();
  let sequence = 0, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('AGENT_CDP_UNAVAILABLE')); }
    pending.clear(); socket.close();
  };
  socket.addEventListener('close', close); socket.addEventListener('error', close);
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 2 * 1024 * 1024) return close();
      const message = JSON.parse(event.data), entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(Error('AGENT_CDP_REJECTED')); else entry.resolve(message.result);
      } else if (typeof message.method === 'string') onEvent(message);
    } catch { close(); }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('AGENT_CDP_TIMED_OUT')), timeoutMs);
      const finish = error => { clearTimeout(timer); error ? reject(Error('AGENT_CDP_UNAVAILABLE')) : resolve(); };
      socket.addEventListener('open', () => finish(false), { once: true });
      socket.addEventListener('error', () => finish(true), { once: true });
      socket.addEventListener('close', () => finish(true), { once: true });
    });
  } catch (error) { close(); throw error; }
  return { close, call(method, params = {}, sessionId) {
    if (closed || pending.size >= 64 || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) return Promise.reject(Error('AGENT_CDP_INVALID'));
    const id = ++sequence, message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    if (Buffer.byteLength(message) > 512 * 1024) return Promise.reject(Error('AGENT_CDP_INVALID'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('AGENT_CDP_TIMED_OUT')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(message); } catch { close(); }
    });
  } };
}
