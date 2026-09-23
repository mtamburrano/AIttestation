import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exists, ownerDirectory } from './environment.mjs';

export async function waitForAgentBrowserCleanup(paths, { timeoutMs = 2000, wait = delay, now = () => performance.now() } = {}) {
  if (paths.chrome !== join(paths.root, 'chrome')) throw Error('AGENT_STATE_UNSAFE');
  const deadline = now() + timeoutMs;
  for (;;) {
    await ownerDirectory(paths.root); await ownerDirectory(paths.chrome);
    // lstat checks singleton existence without following dangling links.
    // RunningChromeVersion is persistent metadata, not a shutdown signal.
    const markers = await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket']
      .map(name => exists(join(paths.chrome, name))));
    if (!markers.some(Boolean)) return;
    const remaining = deadline - now();
    if (remaining <= 0) throw Error('AGENT_BROWSER_CLOSE_TIMED_OUT');
    await wait(Math.min(50, remaining));
  }
}

export async function closeAgentBrowser(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return;
  await new Promise((resolve, reject) => {
    let timer;
    const exited = () => { clearTimeout(timer); resolve(); };
    child.once('exit', exited);
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      timer = setTimeout(() => { child.off('exit', exited); reject(Error('AGENT_BROWSER_CLOSE_TIMED_OUT')); }, 2000);
    }, timeoutMs);
    child.kill('SIGTERM');
  });
}
