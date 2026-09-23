import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { readReleaseFile } from '../distribution/release-inputs.mjs';
import { CHATGPT_EXTENSION_ID } from '../browser/chatgpt/adapter.mjs';

function extensionPreferenceReady(extension, stage) {
  if (!extension || typeof extension !== 'object' || Array.isArray(extension) || extension.path !== stage) return false;
  // Current Chromium uses disable_reasons for unpacked entries and may omit legacy state.
  if (Object.hasOwn(extension, 'state') && (!Number.isSafeInteger(extension.state) || extension.state !== 1)) return false;
  if (!Object.hasOwn(extension, 'disable_reasons')) return true;
  if (Array.isArray(extension.disable_reasons)) {
    return extension.disable_reasons.length === 0
      && extension.disable_reasons.every(reason => Number.isSafeInteger(reason) && reason >= 0);
  }
  return Number.isSafeInteger(extension.disable_reasons) && extension.disable_reasons === 0;
}

async function readExtensionPreference(path, stage) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    return { present: true, valid: false };
  }
  try {
    const preferences = JSON.parse(await readReleaseFile(path, { limit: 8 * 1024 * 1024 }));
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return { present: true, valid: false };
    const extensions = preferences.extensions;
    if (extensions === undefined) return { present: true, valid: true, extension: null };
    if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return { present: true, valid: false };
    const settings = extensions.settings;
    if (settings === undefined) return { present: true, valid: true, extension: null };
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { present: true, valid: false };
    if (!Object.hasOwn(settings, CHATGPT_EXTENSION_ID)) return { present: true, valid: true, extension: null };
    const extension = settings[CHATGPT_EXTENSION_ID];
    return { present: true, valid: extensionPreferenceReady(extension, stage), extension };
  } catch {
    return { present: true, valid: false };
  }
}

export async function agentExtensionReady(paths, stage) {
  if (typeof stage !== 'string' || stage.length === 0) return false;
  for (const name of ['Secure Preferences', 'Preferences']) {
    const result = await readExtensionPreference(join(paths.chrome, 'Default', name), stage);
    if (!result.present) continue;
    if (!result.valid) return false;
    if (result.extension) {
      // A second preference file carrying the same ID must not disagree silently.
      const other = await readExtensionPreference(join(paths.chrome, 'Default', name === 'Secure Preferences' ? 'Preferences' : 'Secure Preferences'), stage);
      if (other.present && !other.valid) return false;
      return true;
    }
  }
  return false;
}

// CDP uses inherited pipes to the exact validated, isolated browser process.
// There is no debugging listener, credential export, UI automation permission,
// or user-gesture/Send command. Only a boolean leaves the session evaluation.
export async function probeAgentLogin(chrome, paths, { spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  let child, timer, sequence = 0, buffer = '', failed = false;
  const pending = new Map();
  let exited;
  const fail = () => {
    failed = true;
    for (const { reject } of pending.values()) reject(Error('PROVIDER_LOGIN_REQUIRED'));
    pending.clear();
    child?.kill('SIGKILL');
  };
  try {
    child = spawnProcess(chrome.executable, [`--user-data-dir=${paths.chrome}`, '--headless=new', '--remote-debugging-pipe',
      '--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-updater-scheduler', 'about:blank'],
    { env: { HOME: paths.home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    child.once('error', fail); child.once('exit', fail);
    exited = new Promise(resolve => child.once('exit', resolve));
    child.stdio[3].on('error', fail); child.stdio[4].on('error', fail);
    timer = setTimeout(fail, timeoutMs);
    child.stdio[4].on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 256 * 1024) return fail();
      for (;;) {
        const end = buffer.indexOf('\0'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { fail(); return; }
        const waiting = pending.get(message.id);
        if (!waiting) continue;
        pending.delete(message.id);
        if (message.error) waiting.reject(Error('PROVIDER_LOGIN_REQUIRED'));
        else waiting.resolve(message.result);
      }
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      if (failed) { reject(Error('PROVIDER_LOGIN_REQUIRED')); return; }
      const id = ++sequence; pending.set(id, { resolve, reject });
      child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    await call('Page.navigate', { url: 'https://chatgpt.com/' }, sessionId);
    let ready = false;
    for (let attempt = 0; attempt < 12 && !ready && !failed; attempt++) {
      const result = await call('Runtime.evaluate', {
        expression: `location.origin === 'https://chatgpt.com' && fetch('/api/auth/session', { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(4000) }).then(async response => { if (!response.ok) return false; const session = await response.json(); return typeof session?.user?.id === 'string' && session.user.id.length > 0 && Date.parse(session.expires) > Date.now() + 60000; }).catch(() => false)`,
        awaitPromise: true, returnByValue: true,
      }, sessionId).catch(() => null);
      ready = result?.result?.type === 'boolean' && result.result.value === true;
      if (!ready) await delay(250);
    }
    await call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(1500)]);
    return ready;
  } catch { return false; }
  finally {
    clearTimeout(timer);
    // This handle belongs only to the process created by this probe.
    child?.kill('SIGKILL');
    child?.stdio[3]?.destroy(); child?.stdio[4]?.destroy();
    if (exited) await Promise.race([exited, delay(1500)]);
  }
}
