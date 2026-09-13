import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { CHROME_BASELINE_MAJOR } from '../browser/chatgpt/adapter.mjs';
import { readReleaseFile } from '../distribution/release-inputs.mjs';

export const DEVELOPMENT_PROFILE = 'pap-private-development/1';
export const TEST_USER = 'attestamp-test';

export function testAccount(info = userInfo()) {
  if (info.username !== TEST_USER || info.uid < 501 || info.homedir !== `/Users/${TEST_USER}`) {
    throw Error('DEDICATED_MACOS_TEST_USER_REQUIRED');
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
  for (const path of [paths.control, paths.chrome, paths.support]) {
    if (await exists(path)) throw Error('TEST_ACCOUNT_ALREADY_HAS_STATE');
    let parent = dirname(path);
    while (!await exists(parent)) parent = dirname(parent);
    if (await realpath(parent) !== parent) throw Error('UNSAFE_TEST_ACCOUNT_ANCESTOR');
  }
  await mkdir(paths.control, { mode: 0o700 });
  await mkdir(paths.chrome, { recursive: true, mode: 0o700 });
  await mkdir(paths.support, { recursive: true, mode: 0o700 });
  await writeNewJSON(join(paths.control, 'account.json'), { profile: DEVELOPMENT_PROFILE, uid: process.getuid() });
}

export async function validateAccount(paths = testAccount()) {
  for (const path of [paths.control, paths.chrome, paths.support]) await ownerDirectory(path);
  const marker = await privateJSON(join(paths.control, 'account.json'));
  if (Object.keys(marker).sort().join(',') !== 'profile,uid' || marker.profile !== DEVELOPMENT_PROFILE
      || marker.uid !== process.getuid()) throw Error('UNRECOGNIZED_TEST_ACCOUNT');
  return paths;
}
