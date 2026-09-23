import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { canonical } from '../vault/format.mjs';
import { DEVELOPMENT_PROFILE, TEST_USER, newDirectory, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';
import { runningChromeProcesses } from './chrome.mjs';

export const AGENT_PROFILE = 'pap-private-agent/1';
export const AGENT_OPT_IN = '--agent-mode';
const fields = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';

export function agentAccount(agent, optIn, info = userInfo()) {
  if (optIn !== AGENT_OPT_IN) throw Error('AGENT_OPT_IN_REQUIRED');
  if (fields(agent) !== 'account,automation,namespace,profile' || agent.profile !== AGENT_PROFILE
      || !['local-api', 'computer-use'].includes(agent.automation)
      || typeof agent.namespace !== 'string' || !/^[a-z][a-z0-9-]{2,19}$/.test(agent.namespace)
      || fields(agent.account) !== 'home,uid,username') throw Error('AGENT_CONFIG_INVALID');
  const { home, uid, username } = agent.account;
  if (username === TEST_USER || username !== info.username || uid !== info.uid || uid < 501
      || !Number.isSafeInteger(uid) || home !== info.homedir || !home.startsWith('/')
      || resolve(home) !== home || home === '/' || home === '/Users'
      || home === `/Users/${TEST_USER}` || home.startsWith(`/Users/${TEST_USER}/`)) throw Error('AGENT_ACCOUNT_MISMATCH');
  // A fresh, fixed subtree prevents callers from selecting a retained kit,
  // production support directory, browser profile, or an ancestor of them.
  const root = join(home, `.attestamp-agent-${agent.namespace}`);
  const paths = { home, root, control: join(root, 'control'), support: join(root, 'support'),
    chrome: join(root, 'chrome'), extension: join(root, 'extension'), builds: join(root, 'builds'),
    browser: join(root, 'browser'), chromeApplication: join(root, 'browser/Google Chrome.app'),
    keychainService: `ai.provenance.agent.${uid}.${agent.namespace}` };
  if (Buffer.byteLength(join(paths.support, 'bridge-000000000000.sock')) >= 104) throw Error('AGENT_PATH_TOO_LONG');
  return paths;
}

export function agentBuildPath(paths, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name)) throw Error('AGENT_BUILD_NAME_INVALID');
  return join(paths.builds, name);
}

export function validateAgentLaunch(request, build, now = Date.now()) {
  if (fields(request) !== 'build,createdAt,mode,profile' || request.profile !== AGENT_PROFILE
      || request.build !== build || !['offline', 'live-provider-send'].includes(request.mode)
      || !Number.isSafeInteger(request.createdAt) || request.createdAt > now || now - request.createdAt > 60000) {
    throw Error('AGENT_EXPLICIT_SESSION_REQUIRED');
  }
  return request;
}

export async function initializeAgent(agent, optIn, info) {
  const paths = agentAccount(agent, optIn, info);
  await newDirectory(paths.root);
  for (const name of ['control', 'support', 'chrome', 'extension', 'builds', 'browser']) await mkdir(paths[name], { mode: 0o700 });
  // Retain the normal control marker so the existing guarded stop operation
  // can be reused, but require the complete namespace marker on every entry.
  await writeNewJSON(join(paths.control, 'account.json'), { profile: DEVELOPMENT_PROFILE, uid: agent.account.uid });
  await writeNewJSON(join(paths.root, 'agent.json'), agent);
  return { profile: AGENT_PROFILE, initialized: true };
}

export async function validateAgent(agent, optIn, info) {
  const paths = agentAccount(agent, optIn, info);
  for (const name of ['root', 'control', 'support', 'chrome', 'extension', 'builds', 'browser']) await ownerDirectory(paths[name]);
  if (canonical(await privateJSON(join(paths.root, 'agent.json'))) !== canonical(agent)) throw Error('AGENT_NAMESPACE_MISMATCH');
  const marker = await privateJSON(join(paths.control, 'account.json'));
  if (fields(marker) !== 'profile,uid' || marker.profile !== DEVELOPMENT_PROFILE || marker.uid !== agent.account.uid) {
    throw Error('AGENT_NAMESPACE_MISMATCH');
  }
  return paths;
}

// Reject redirected descendants before any stateful component is started.
// Chrome's own singleton links are the only exceptions and are never followed.
export async function validateAgentState(paths, { processes = runningChromeProcesses, requireStoppedBrowser = false } = {}) {
  if (requireStoppedBrowser && processes().length) throw Error('CLOSE_OTHER_CHROME_COPY');
  let entries = 0;
  const visit = async (directory, chrome = false) => {
    for (const name of await readdir(directory)) {
      if (++entries > 100000) throw Error('AGENT_STATE_LIMIT');
      const path = join(directory, name), info = await lstat(path);
      // macOS app shims publish this runtime link. It is never safe idle state,
      // and must not be followed or added to the singleton-link exceptions.
      if (chrome && directory === paths.chrome && name === 'RunningChromeVersion') {
        throw Error(processes().length ? 'CLOSE_OTHER_CHROME_COPY' : 'AGENT_STATE_UNSAFE');
      }
      if (chrome && directory === paths.chrome && ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name)) continue;
      if (info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)
          || !info.isDirectory() && (!info.isFile() || info.nlink !== 1) || await realpath(path) !== path) {
        throw Error('AGENT_STATE_UNSAFE');
      }
      if (info.isDirectory()) await visit(path, chrome);
    }
  };
  for (const name of ['control', 'support', 'chrome']) await visit(paths[name], name === 'chrome');
}
