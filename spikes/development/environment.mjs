import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { CHROME_BASELINE_MAJOR } from '../browser/chatgpt/adapter.mjs';
import { readReleaseFile } from '../distribution/release-inputs.mjs';

export const DEVELOPMENT_PROFILE = 'pap-private-development/1';
export const TEST_USER = 'attestamp-test';
export const PRIVATE_ACCEPTANCE_NAMESPACE = '6d1110ab';

export function validatePrivateNamespace(namespace) {
  if (namespace === undefined || namespace === null) return null;
  if (namespace !== PRIVATE_ACCEPTANCE_NAMESPACE) throw Error('UNRECOGNIZED_PRIVATE_ACCEPTANCE_NAMESPACE');
  return namespace;
}

export function privateManifestNamespace(manifest) {
  const namespace = validatePrivateNamespace(manifest?.namespace);
  const fields = ['assurance', 'browserPolicy', 'profile', 'sponsorOrigin', 'updaterEnabled',
    ...(Object.hasOwn(manifest ?? {}, 'namespace') ? ['namespace'] : [])].sort().join(',');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(',') !== fields || manifest.profile !== DEVELOPMENT_PROFILE
      || manifest.assurance !== 'PRIVATE_TESTNET_ONLY' || manifest.browserPolicy !== 'EXPLICIT_TEST_USER_COPY'
      || manifest.updaterEnabled !== false || Object.hasOwn(manifest, 'namespace') && !namespace) {
    throw Error('INVALID_PRIVATE_BUILD');
  }
  return namespace;
}

export function validatePrivateLaunchRequest(request, namespace) {
  const modeFields = { 'live-chatgpt-testnet': 'chromeApplication,mode,profile',
    backup: 'mode,outputDirectory,profile', restore: 'mode,outputDirectory,packageFile,profile,secretFile' };
  const selectedNamespace = validatePrivateNamespace(namespace);
  const requestNamespace = Object.hasOwn(request ?? {}, 'namespace')
    ? validatePrivateNamespace(request.namespace) : null;
  const expected = modeFields[request?.mode];
  if (!expected || request.profile !== DEVELOPMENT_PROFILE || requestNamespace !== selectedNamespace
      || Object.keys(request).sort().join(',') !== (selectedNamespace ? `${expected},namespace` : expected).split(',').sort().join(',')) {
    throw Error('EXPLICIT_PRIVATE_OPERATION_REQUIRED');
  }
  return request;
}

export function testAccount(info = userInfo(), selectedNamespace = null) {
  if (info.username !== TEST_USER || info.uid < 501 || info.homedir !== `/Users/${TEST_USER}`) {
    throw Error('DEDICATED_MACOS_TEST_USER_REQUIRED');
  }
  const namespace = validatePrivateNamespace(selectedNamespace);
  if (namespace) {
    const root = join(info.homedir, `.attestamp-private-acceptance-${namespace}`);
    return { home: info.homedir, namespace, root, control: join(root, 'control'),
      support: join(root, 'support'), chrome: join(root, 'chrome') };
  }
  return {
    home: info.homedir,
    control: join(info.homedir, '.attestamp-private-test'),
    support: join(info.homedir, 'Library/Application Support/Private Provenance'),
    chrome: join(info.homedir, 'Library/Application Support/Google/Chrome'),
  };
}

export function assertPlatform({ platform, arch, osVersion, chromeVersion }) {
  const [major, minor] = String(osVersion).split('.').map(Number);
  if (platform !== 'darwin' || arch !== 'arm64' || !(major > 15 || major === 15 && minor >= 7)) {
    throw Error('SUPPORTED_APPLE_SILICON_MAC_REQUIRED');
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(chromeVersion) || Number(chromeVersion.split('.')[0]) !== CHROME_BASELINE_MAJOR) {
    throw Error(`CHROME_${CHROME_BASELINE_MAJOR}_REQUIRED`);
  }
}

export async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function ownerDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)
      || await realpath(path) !== path) throw Error('UNSAFE_PRIVATE_TEST_DIRECTORY');
}

export async function newDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) {
    throw Error('CANONICAL_NEW_TEST_DIRECTORY_REQUIRED');
  }
  // Seeds, credentials and generated configurations must never enter a checkout.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (await exists(join(parent, '.git'))) throw Error('TEST_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORIES');
    if (parent === dirname(parent)) break;
  }
  await mkdir(path, { mode: 0o700 });
  await ownerDirectory(path);
}

export async function privateJSON(path) {
  return JSON.parse(await readReleaseFile(path, { privateFile: true }));
}

export async function writeNewJSON(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function initializeAccount(paths = testAccount()) {
  // Refuse to adopt any pre-existing browser, vault or control directory.
  if (paths.namespace) validatePrivateNamespace(paths.namespace);
  const selected = paths.root ? [paths.root, paths.control, paths.chrome, paths.support]
    : [paths.control, paths.chrome, paths.support];
  for (const path of selected) {
    if (await exists(path)) throw Error('TEST_ACCOUNT_ALREADY_HAS_STATE');
    let parent = dirname(path);
    while (!await exists(parent)) parent = dirname(parent);
    if (await realpath(parent) !== parent) throw Error('UNSAFE_TEST_ACCOUNT_ANCESTOR');
  }
  if (paths.root) {
    await newDirectory(paths.root);
    for (const path of [paths.control, paths.chrome, paths.support]) await mkdir(path, { mode: 0o700 });
    for (const path of [paths.root, paths.control, paths.chrome, paths.support]) await ownerDirectory(path);
  } else {
    await mkdir(paths.control, { mode: 0o700 });
    await mkdir(paths.chrome, { recursive: true, mode: 0o700 });
    await mkdir(paths.support, { recursive: true, mode: 0o700 });
  }
  await writeNewJSON(join(paths.control, 'account.json'), { profile: DEVELOPMENT_PROFILE, uid: process.getuid(),
    ...(paths.namespace ? { namespace: validatePrivateNamespace(paths.namespace) } : {}) });
}

export async function validateAccount(paths = testAccount()) {
  if (paths.root) await ownerDirectory(paths.root);
  for (const path of [paths.control, paths.chrome, paths.support]) await ownerDirectory(path);
  const marker = await privateJSON(join(paths.control, 'account.json'));
  const fields = paths.namespace ? 'namespace,profile,uid' : 'profile,uid';
  if (Object.keys(marker).sort().join(',') !== fields || marker.profile !== DEVELOPMENT_PROFILE
      || marker.namespace !== (paths.namespace ?? undefined)
      || marker.uid !== process.getuid()) throw Error('UNRECOGNIZED_TEST_ACCOUNT');
  return paths;
}
