import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { RELEASE_CANDIDATE_PROFILE, RELEASE_CHANNELS, validateInstalledRelease, validateReleaseCandidate } from './config.mjs';
import { distributionError } from './release.mjs';
import { localCommand, localGit } from './local.mjs';

export async function assertReleasePath(path, { directory = false, privateFile = false } = {}) {
  if (!isAbsolute(path) || path === parse(path).root || resolve(path) !== path || await realpath(path) !== path) throw Error('Unsafe release input path');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current), leaf = current === path;
    const trustedOwner = info.uid === process.getuid() || (!privateFile || !leaf) && info.uid === 0;
    const stickyAncestor = !leaf && info.isDirectory() && info.uid === 0 && (info.mode & 0o1000);
    if (!trustedOwner || info.isSymbolicLink() || ((info.mode & 0o022) && !stickyAncestor)
        || (!leaf && !info.isDirectory()) || (leaf && (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))
        || (leaf && privateFile && (info.mode & 0o077))) throw Error('Unsafe release input permissions');
  }
}

export async function readReleaseFile(path, { limit = 16 * 1024, privateFile = false } = {}) {
  await assertReleasePath(path, { privateFile });
  // O_NONBLOCK also prevents a raced FIFO from hanging an unattended preflight.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.uid !== process.getuid() && (privateFile || info.uid !== 0))
        || (info.mode & (privateFile ? 0o077 : 0o022)) || info.size > limit) throw Error('Unsafe release input file');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) { bytes.fill(0); throw Error('Release input too large'); }
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export async function readReleaseConfig(path) {
  return JSON.parse(await readReleaseFile(path, { privateFile: true }));
}

export async function validateReleasePermissions(config) {
  for (const path of [config.updatePrivateKeyFile, config.dependencyApprovalFile]) {
    await assertReleasePath(path, { privateFile: true });
  }
  for (const path of [config.helperProvisioningProfile, config.goExecutable, process.execPath,
    resolve(process.execPath, '../../LICENSE')]) await assertReleasePath(path);
  for (const path of [config.goExecutable, process.execPath]) {
    if (!((await lstat(path)).mode & 0o100)) throw Error('Release tool is not executable');
  }
  await assertReleasePath(config.goModuleCache, { directory: true });
}

export function assertCleanSource(root, command = localCommand) {
  if (localGit(root, ['rev-parse', '--show-toplevel'], command).trim() !== resolve(root)
      || !/^[a-f0-9]{40,64}$/.test(localGit(root, ['rev-parse', '--verify', 'HEAD'], command).trim())
      || localGit(root, ['ls-files', '-v', '-z'], command).split('\0').filter(Boolean).some(entry => !entry.startsWith('H '))
      || localGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], command)) {
    throw Error('Signed releases require a clean source checkout');
  }
}

export async function readReleaseApproval(config) {
  return JSON.parse(await readReleaseFile(config.dependencyApprovalFile, { privateFile: true }));
}

export async function readUpdateSigningKey(config) {
  const secret = await readReleaseFile(config.updatePrivateKeyFile, { limit: 4096, privateFile: true });
  let key;
  try { key = createPrivateKey(secret); } finally { secret.fill(0); }
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ format: 'jwk' }).x !== config.updatePublicKey) {
    throw Error('Release signing key does not match the pinned update public key');
  }
  return key;
}

export function validateHelperProfile(profile, config, now = Date.now()) {
  const { Entitlements: entitlements, TeamIdentifier: teams, ExpirationDate: expires } = profile;
  const appId = `${config.teamId}.ai.provenance.keychain-helper`, group = `${config.teamId}.ai.provenance.evidence-vault`;
  if (!Array.isArray(teams) || !teams.every(team => typeof team === 'string') || !teams.includes(config.teamId)
      || typeof expires !== 'string' || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= now
      || !entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)
      || entitlements['com.apple.application-identifier'] !== appId
      || !Array.isArray(entitlements['keychain-access-groups'])
      || !entitlements['keychain-access-groups'].every(value => typeof value === 'string')
      || !entitlements['keychain-access-groups'].some(value => value === group || value === `${config.teamId}.*`)
      || profile.ProvisionsAllDevices !== true) throw Error('Invalid Developer ID helper provisioning profile');
  return { appId, group };
}

export function helperProfileFromPlist(bytes, command = localCommand) {
  if (!bytes.length || Buffer.byteLength(bytes) > 1024 * 1024) throw Error('Invalid helper profile size');
  const extract = (key, format, type) => command('/usr/bin/plutil', ['-extract', key, format, '-expect', type, '-o', '-', '--', '-'], { input: bytes }).trim();
  // Convert only the extracted subtree: plutil cannot convert a parent profile
  // containing date/data values to JSON, even when extracting a JSON-safe key.
  const json = (key, type) => JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
    { input: extract(key, 'xml1', type) }));
  return { Entitlements: json('Entitlements', 'dictionary'), TeamIdentifier: json('TeamIdentifier', 'array'),
    ExpirationDate: extract('ExpirationDate', 'raw', 'date'), ProvisionsAllDevices: JSON.parse(extract('ProvisionsAllDevices', 'raw', 'bool')) };
}

export async function inspectLocalHelperProfile(config, command, now = Date.now()) {
  const bytes = await readReleaseFile(config.helperProvisioningProfile, { limit: 1024 * 1024 });
  // Decode/verify the embedded CMS signature locally, without certificate trust
  // lookup, Keychain access or revocation requests. Apple trust is a build gate.
  const decoded = command('/usr/bin/openssl', ['smime', '-verify', '-inform', 'DER', '-noverify', '-binary'], { input: bytes });
  validateHelperProfile(helperProfileFromPlist(decoded, command), config, now);
}

export function releaseBuildPlan(config) {
  const releaseChannel = config?.releaseChannel === undefined ? RELEASE_CHANNELS.PRODUCTION : config.releaseChannel;
  if (![RELEASE_CHANNELS.PRODUCTION, RELEASE_CHANNELS.CANDIDATE].includes(releaseChannel)) {
    throw distributionError('INVALID_RELEASE_CHANNEL');
  }
  const candidate = releaseChannel === RELEASE_CHANNELS.CANDIDATE;
  return { releaseChannel, releaseClass: candidate ? 'RELEASE_CANDIDATE' : 'PRODUCTION',
    stableManifestCreated: !candidate, updaterEnabled: !candidate, installedProductionState: !candidate };
}

export function releaseArtifactContract(config) {
  const plan = releaseBuildPlan(config);
  if (typeof config?.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(config.version)
      || !Number.isSafeInteger(config.sequence) || config.sequence < 1) {
    throw distributionError('INVALID_RELEASE_ARTIFACT');
  }
  const candidate = plan.releaseClass === 'RELEASE_CANDIDATE';
  return { ...plan,
    artifactName: candidate
      ? `Attestamp-Release-Candidate-${config.version}-${config.sequence}.dmg`
      : `Private-Provenance-${config.version}-${config.sequence}.dmg`,
    stableManifest: candidate ? null : 'stable.json',
    bundledInstalledRelease: candidate ? null : 'installed-release.json',
    updaterAvailable: !candidate,
    promotion: candidate ? 'FRESH_PRODUCTION_BUILD_REQUIRED' : 'PRODUCTION_RELEASE',
  };
}

export function validateBuildConfig(config) {
  const { releaseChannel } = releaseBuildPlan(config);
  const metadata = Object.fromEntries(['sequence', 'version', 'teamId', 'updateOrigin', 'updatePublicKey', 'storeListingVerified']
    .map(name => [name, config[name]]));
  const validated = releaseChannel === RELEASE_CHANNELS.CANDIDATE
    ? validateReleaseCandidate({ profile: RELEASE_CANDIDATE_PROFILE, releaseChannel, ...metadata })
    : validateInstalledRelease({ profile: 'pap-installed-release/1', ...metadata });
  if (typeof config.signingIdentity !== 'string' || !/^Developer ID Application: [^\n\r]+$/.test(config.signingIdentity)
      || typeof config.notaryProfile !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(config.notaryProfile)
      || !['helperProvisioningProfile', 'updatePrivateKeyFile', 'dependencyApprovalFile', 'goExecutable', 'goModuleCache']
        .every(name => typeof config[name] === 'string' && isAbsolute(config[name]))) {
    throw Error('Release identities, provisioning, dependency approval and build tools must be explicitly configured');
  }
  return validated;
}
