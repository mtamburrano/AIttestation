import { lstat, mkdir, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { canonical } from '../vault/format.mjs';
import { discoverClients } from '../coding/discovery.mjs';
import { DEVELOPMENT_PROFILE, TEST_USER, newDirectory, ownerDirectory, privateJSON, writeNewJSON } from './environment.mjs';

export const OWNER_ACCEPTANCE_PROFILE = 'pap-private-owner-acceptance/1';
const fields = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';

export function validateOwnerAcceptanceConfig(owner) {
  if (fields(owner) !== 'account,namespace,profile' || owner.profile !== OWNER_ACCEPTANCE_PROFILE
      || typeof owner.namespace !== 'string' || !/^[a-f0-9]{12}$/.test(owner.namespace)
      || fields(owner.account) !== 'home,uid,username') throw Error('OWNER_ACCEPTANCE_CONFIG_INVALID');
  const { home, uid, username } = owner.account;
  if (!Number.isSafeInteger(uid) || uid < 501 || typeof username !== 'string'
      || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(username) || username === TEST_USER
      || typeof home !== 'string' || !isAbsolute(home) || resolve(home) !== home
      || ['/', '/Users', `/Users/${TEST_USER}`].includes(home) || home.startsWith(`/Users/${TEST_USER}/`)) {
    throw Error('OWNER_ACCEPTANCE_ACCOUNT_INVALID');
  }
  return owner;
}

export function ownerAcceptanceAccount(owner, info = userInfo()) {
  validateOwnerAcceptanceConfig(owner);
  const { home, uid, username } = owner.account;
  if (info.username !== username || info.uid !== uid || info.homedir !== home) throw Error('OWNER_ACCEPTANCE_ACCOUNT_MISMATCH');
  // No caller-selected support directory: every namespace has one exclusive root.
  const root = join(home, `.attestamp-owner-${owner.namespace}`);
  const paths = { home, root, control: join(root, 'control'), support: join(root, 'support'), chrome: join(root, 'chrome'),
    builds: join(root, 'builds'), keychainService: `ai.provenance.owner.${uid}.${owner.namespace}` };
  if (Buffer.byteLength(join(paths.support, 'bridge-000000000000.sock')) >= 104
      || Buffer.byteLength(join(paths.support, 'hook-000000000000.sock')) > 100) throw Error('OWNER_ACCEPTANCE_PATH_TOO_LONG');
  return paths;
}

export async function initializeOwnerAcceptance(owner, info) {
  const paths = ownerAcceptanceAccount(owner, info);
  await newDirectory(paths.root);
  for (const name of ['control', 'support', 'chrome', 'builds']) await mkdir(paths[name], { mode: 0o700 });
  await writeNewJSON(join(paths.root, 'owner-acceptance.json'), owner);
  await writeNewJSON(join(paths.control, 'account.json'), { profile: DEVELOPMENT_PROFILE, uid: owner.account.uid });
  return paths;
}

export async function validateOwnerAcceptance(owner, info) {
  const paths = ownerAcceptanceAccount(owner, info);
  for (const name of ['root', 'control', 'support', 'chrome', 'builds']) await ownerDirectory(paths[name]);
  if (canonical(await privateJSON(join(paths.root, 'owner-acceptance.json'))) !== canonical(owner)
      || canonical(await privateJSON(join(paths.control, 'account.json')))
        !== canonical({ profile: DEVELOPMENT_PROFILE, uid: owner.account.uid })) throw Error('OWNER_ACCEPTANCE_STATE_MISMATCH');
  return paths;
}

export async function validateOwnerAcceptanceState(paths, { chrome = null } = {}) {
  let entries = 0;
  const visit = async directory => {
    for (const name of await readdir(directory)) {
      if (++entries > 100000) throw Error('OWNER_ACCEPTANCE_STATE_LIMIT');
      const path = join(directory, name), info = await lstat(path);
      // A crash can leave an epoch-specific socket. The resident lock and fresh
      // rendezvous select the new instance; inspection neither connects nor unlinks.
      if (directory === paths.support && /^(?:bridge|hook)-[a-f0-9]{8}-[a-f0-9]{3}\.sock$/.test(name)
          && info.isSocket() && info.uid === process.getuid() && info.nlink === 1 && !(info.mode & 0o077)
          && await realpath(path) === path) continue;
      if (directory === paths.chrome && info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1) {
        // Chromium's root singleton links and version token are metadata, not
        // filesystem subtrees. Never follow them into another user's profile.
        if (['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name)) continue;
        if (name === 'RunningChromeVersion' && info.size <= 45) {
          const target = await readlink(path);
          const match = /^((?:0|[1-9][0-9]{0,9})(?:\.(?:0|[1-9][0-9]{0,9})){3})(?::[01])?$/.exec(target);
          if (match && match[0] === target && match[1].split('.').every(part => Number(part) <= 0xffffffff)
              && (!chrome || match[1] === chrome.version)) continue;
        }
      }
      if (info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)
          || !info.isDirectory() && (!info.isFile() || info.nlink !== 1) || await realpath(path) !== path) {
        throw Error('OWNER_ACCEPTANCE_STATE_UNSAFE');
      }
      if (info.isDirectory()) await visit(path);
    }
  };
  for (const name of ['control', 'support', 'chrome']) await visit(paths[name]);
}

export function ownerAcceptanceManifest(owner) {
  validateOwnerAcceptanceConfig(owner);
  return { profile: DEVELOPMENT_PROFILE, ownerAcceptance: owner, sponsorOrigin: null,
    assurance: 'PRIVATE_LOCAL_OWNER_ACCEPTANCE', updaterEnabled: false, browserPolicy: 'EXPLICIT_TEST_USER_COPY' };
}

export function validateOwnerAcceptanceManifest(manifest) {
  if (canonical(manifest) !== canonical(ownerAcceptanceManifest(manifest?.ownerAcceptance))) throw Error('INVALID_OWNER_ACCEPTANCE_BUILD');
  return manifest.ownerAcceptance;
}

export function validateOwnerAcceptanceLaunch(request, owner) {
  const modes = { 'owner-acceptance': 'chromeApplication,mode,ownerAcceptance,profile',
    backup: 'mode,outputDirectory,ownerAcceptance,profile', restore: 'mode,outputDirectory,ownerAcceptance,packageFile,profile,secretFile' };
  if (fields(request) !== modes[request?.mode] || request.profile !== DEVELOPMENT_PROFILE
      || canonical(request.ownerAcceptance) !== canonical(validateOwnerAcceptanceConfig(owner))) {
    throw Error('EXPLICIT_OWNER_ACCEPTANCE_OPERATION_REQUIRED');
  }
  return request;
}

export function ownerAcceptanceRuntimeOptions(owner, info, discover = discoverClients) {
  const paths = ownerAcceptanceAccount(owner, info);
  return { managed: null, integrationHomes: { codex: join(paths.home, '.codex'), 'claude-code': join(paths.home, '.claude'),
    firefox: join(paths.home, 'Library/Application Support/Mozilla/NativeMessagingHosts') },
  discoverClients: ({ client }) => discover({ client, home: paths.home }) };
}
