import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { canonical } from '../vault/format.mjs';
import { RELEASE_CANDIDATE_PROFILE, RELEASE_CHANNELS, validateInstalledRelease, validateReleaseCandidate } from './config.mjs';
import { dependencyInventory, fileInventory, sourceInventory } from './inventory.mjs';
import { RELEASE_PROFILE, distributionError, sha256, validateRelease } from './release.mjs';
import { assertPortableExecutable } from '../recipient/build-macos.mjs';
import { readOwned } from './files.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extensionRoot = join(root, 'spikes/browser/chatgpt/extension');
const requiredExtensionIconSizes = ['16', '32', '48', '128'];
const run = (command, args, extra = {}) => execFileSync(command, args, {
  env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: 'pipe', maxBuffer: 4 * 1024 * 1024, ...extra,
});
const plist = values => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) =>
  `<key>${key}</key>${value === true ? '<true/>' : Array.isArray(value)
    ? `<array>${value.map(item => `<string>${item}</string>`).join('')}</array>` : `<string>${value}</string>`}`).join('')}</dict></plist>`;
const releaseCandidateNotice = `# RELEASE CANDIDATE — PRE-PUBLICATION REVIEW ONLY

This signed and notarized build is for designated reviewer validation before the Chrome Web Store listing is published. It is not a production release, has no stable update channel, and must not be promoted in place. Produce a fresh production build after the listing and installed validation are complete.`;

export function prepareChromeWebStoreManifest(manifest) {
  const uploadManifest = structuredClone(manifest);
  delete uploadManifest.key;
  return uploadManifest;
}

async function validateExtensionPackage(manifest, directory) {
  if (typeof manifest.key !== 'string' || !manifest.key) {
    throw Error('Development extension manifest must retain its public key');
  }
  if (!requiredExtensionIconSizes.every(size => typeof manifest.icons?.[size] === 'string')) {
    throw Error('Chrome Web Store upload requires 16, 32, 48 and 128 pixel icons');
  }
  for (const size of requiredExtensionIconSizes) {
    const icon = manifest.icons[size];
    if (!icon || icon.startsWith('/') || icon.split('/').includes('..')) throw Error('Extension icon path is unsafe');
    const info = await stat(join(directory, icon));
    if (!info.isFile()) throw Error(`Extension icon is not a file: ${icon}`);
  }
}

export async function createChromeWebStoreUpload(output) {
  const staging = await mkdtemp(join(output, '.chrome-web-store-upload-'));
  try {
    const packageRoot = join(staging, 'extension');
    await cp(extensionRoot, packageRoot, { recursive: true });
    const manifestPath = join(packageRoot, 'manifest.json');
    const developmentManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await validateExtensionPackage(developmentManifest, packageRoot);
    await writeFile(manifestPath, `${JSON.stringify(prepareChromeWebStoreManifest(developmentManifest), null, 2)}\n`);
    const archive = join(output, 'Chrome-Web-Store-upload.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', packageRoot, archive]);
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
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

async function configureHelper(app, config, work) {
  const contents = join(app, 'Contents');
  const helperContents = join(contents, 'Helpers/Private Provenance Keychain.app/Contents');
  await mkdir(join(helperContents, 'MacOS'), { recursive: true });
  await rename(join(contents, 'MacOS/provenance-keychain-helper'), join(helperContents, 'MacOS/provenance-keychain-helper'));
  await writeFile(join(helperContents, 'Info.plist'), plist({ CFBundleIdentifier: 'ai.provenance.keychain-helper',
    CFBundleExecutable: 'provenance-keychain-helper', CFBundlePackageType: 'APPL', CFBundleVersion: String(config.sequence) }));
  const decoded = join(work, 'helper-profile.plist');
  await writeFile(decoded, run('/usr/bin/security', ['cms', '-D', '-i', config.helperProvisioningProfile]));
  const entitlements = JSON.parse(run('/usr/bin/plutil', ['-extract', 'Entitlements', 'json', '-o', '-', decoded]));
  const teams = JSON.parse(run('/usr/bin/plutil', ['-extract', 'TeamIdentifier', 'json', '-o', '-', decoded]));
  const expires = run('/usr/bin/plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', decoded]).trim();
  const appId = `${config.teamId}.ai.provenance.keychain-helper`, group = `${config.teamId}.ai.provenance.evidence-vault`;
  if (!teams.includes(config.teamId) || Date.parse(expires) <= Date.now() || !Number.isFinite(Date.parse(expires))
      || entitlements['com.apple.application-identifier'] !== appId
      || !entitlements['keychain-access-groups']?.some(value => value === group || value === `${config.teamId}.*`)
      || run('/usr/bin/plutil', ['-extract', 'ProvisionsAllDevices', 'raw', '-o', '-', decoded]).trim() !== 'true') {
    throw Error('A valid Developer ID provisioning profile for the fixed Keychain helper is required');
  }
  await copyFile(config.helperProvisioningProfile, join(helperContents, 'embedded.provisionprofile'));
  const entitlementFile = join(work, 'keychain.entitlements');
  await writeFile(entitlementFile, plist({ 'com.apple.application-identifier': appId,
    'com.apple.developer.team-identifier': config.teamId, 'keychain-access-groups': [group] }));
  run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'swift-cache'), '-O', '-D', 'PRODUCT_CHATGPT',
    '-D', 'PRODUCT_RELEASE', '-framework', 'Security', join(root, 'spikes/vault/native/macos-app-host.swift'),
    '-o', join(contents, 'MacOS/provenance-app-host')]);
  return { app: dirname(helperContents), entitlements: entitlementFile };
}

async function signBundle(app, config, work, helper = null) {
  const nodeEntitlements = join(work, 'node.entitlements');
  await writeFile(nodeEntitlements, plist({ 'com.apple.security.cs.allow-jit': true }));
  const signPath = (path, identifier, entitlements) => run('/usr/bin/codesign', ['--force', '--sign', config.signingIdentity,
    '--timestamp', '--options', 'runtime', ...(identifier ? ['--identifier', identifier] : []),
    ...(entitlements ? ['--entitlements', entitlements] : []), path]);
  for (const item of await fileInventory(app)) {
    if (!/Contents\/(MacOS\/|Resources\/spikes\/anchor\/algorand\/bin\/)/.test(item.path)) continue;
    if (item.path.includes('/Helpers/') || !((await stat(join(app, item.path))).mode & 0o111)) continue;
    const path = join(app, item.path); assertPortableExecutable(path);
    // Keep the identifiers checked by the native ancestry validator intact.
    const name = item.path.split('/').at(-1);
    const ids = { node: app.endsWith('Verifier.app') ? 'ai.provenance.verifier.runtime' : 'ai.provenance.consumer.runtime',
      'provenance-browser-host': 'ai.provenance.consumer.browser-host',
      'provenance-bridge-peer-validator': 'ai.provenance.consumer.bridge-peer-validator' };
    signPath(path, ids[name], name === 'node' ? nodeEntitlements : null);
  }
  if (helper) signPath(helper.app, null, helper.entitlements);
  signPath(app); run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
    `anchor apple generic and certificate leaf[subject.OU] = "${config.teamId}"`, app]);
}

async function notarize(path, profile) {
  const response = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', path, '--keychain-profile', profile,
    '--wait', '--timeout', '20m', '--output-format', 'json']));
  if (response.status !== 'Accepted') throw Error('Apple notarization did not accept the artifact');
  return { id: response.id, status: response.status };
}

export async function buildDistribution(output, config = null) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Apple-silicon macOS builder required');
  const releasePlan = config ? releaseBuildPlan(config) : null;
  const releaseChannel = releasePlan?.releaseChannel ?? null;
  const isReleaseCandidate = releasePlan?.releaseClass === 'RELEASE_CANDIDATE';
  const releaseMetadata = config ? validateBuildConfig(config) : null;
  const sources = await sourceInventory(root), dependencies = await dependencyInventory(root, { goExecutable: config?.goExecutable ?? null });
  const dependencyDigest = sha256(canonical(dependencies));
  let privateKey;
  if (config) {
    if (run('/usr/bin/git', ['status', '--porcelain'], { cwd: root }).trim()) throw Error('Signed releases require a clean source checkout');
    const approval = JSON.parse(await readFile(config.dependencyApprovalFile, 'utf8'));
    if (approval.inventoryDigest !== dependencyDigest || approval.securityApproved !== true || approval.licensesApproved !== true
        || typeof approval.reviewer !== 'string' || !approval.reviewer.trim()
        || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) {
      throw Error('Current security and license approval must cover this exact dependency inventory');
    }
    if ((await lstat(config.updatePrivateKeyFile)).mode & 0o077) throw Error('Release signing key must be owner-only');
    const secret = await readOwned(config.updatePrivateKeyFile, 4096);
    if (!secret) throw Error('Release signing key missing');
    try { privateKey = createPrivateKey(secret); } finally { secret.fill(0); }
    if (privateKey.asymmetricKeyType !== 'ed25519' || createPublicKey(privateKey).export({ format: 'jwk' }).x !== config.updatePublicKey) {
      throw Error('Release signing key does not match the pinned update public key');
    }
  }
  // The development builder only creates a fresh output; it never registers a
  // native host, accesses an evidence store or installs into Applications.
  run(process.execPath, [join(root, 'spikes/browser/chatgpt/build-macos.mjs'), output]);
  await writeFile(join(output, 'dependency-inventory.json'), canonical(dependencies));
  const app = join(output, 'Private Provenance.app'), recipient = join(output, 'Recipient/Private Provenance Verifier.app');
  for (const bundle of [app, recipient]) {
    await copyFile(join(root, 'spikes/distribution/THIRD_PARTY_NOTICES.md'), join(bundle, 'Contents/Resources/THIRD_PARTY_NOTICES.md'));
    // Adding notices changes the development seal; reseal before returning an
    // inspectable ad-hoc build or proceeding to distribution signing.
    run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  }
  const installGuide = await readFile(join(root, 'spikes/distribution/INSTALL.md'), 'utf8');
  await writeFile(join(output, 'Install and remove.md'), isReleaseCandidate
    ? `${releaseCandidateNotice}\n\n${installGuide}` : installGuide);
  if (isReleaseCandidate) {
    const startHere = await readFile(join(output, 'Start Here.md'), 'utf8');
    await writeFile(join(output, 'Start Here.md'), `${releaseCandidateNotice}\n\n${startHere}`);
  }
  await createChromeWebStoreUpload(output);
  if (!config) {
    await writeFile(join(output, 'build-provenance.json'), canonical({ profile: 'pap-build-provenance/1',
      releaseChannel: 'development', releaseClass: 'DEVELOPMENT', signature: 'AD_HOC_ONLY', notarized: false,
      storeListing: 'NOT_PROVISIONED', source: sources,
      dependencyDigest, sourceRebuiltNativeTools: false,
      manualMeasurements: { osPermissionSteps: null, storePermissionSteps: null, installedPairingMs: null } }));
    return { output, releaseReady: false };
  }
  const work = join(output, '.release-work'); await mkdir(work);
  try {
    const helper = await configureHelper(app, config, work);
    const goDirectory = join(root, 'spikes/anchor/algorand');
    for (const [binary, command] of [['verify', 'verify'], ['fast-verify', 'fastverify'], ['fast-observe', 'fastobserve']]) {
      const target = join(app, 'Contents/Resources/spikes/anchor/algorand/bin', binary);
      run(config.goExecutable, ['build', '-trimpath', '-mod=readonly', '-buildvcs=false', '-o', target, `./cmd/${command}`], {
        cwd: goDirectory, env: { PATH: '/usr/bin:/bin', GOENV: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off',
          GOMODCACHE: config.goModuleCache, GOCACHE: join(work, 'go-cache'), CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: 'arm64' },
      });
      if (binary === 'verify') await copyFile(target, join(recipient, 'Contents/Resources/spikes/anchor/algorand/bin/verify'));
    }
    const installedReleasePath = join(app, 'Contents/Resources/spikes/distribution/installed-release.json');
    const releaseCandidatePath = join(app, 'Contents/Resources/spikes/distribution/release-candidate.json');
    if (isReleaseCandidate) {
      // A candidate is runnable for reviewer checks but is never an installed
      // production release and never receives the stable update channel.
      await writeFile(installedReleasePath, canonical(null));
      await writeFile(releaseCandidatePath, canonical(releaseMetadata));
      await writeFile(join(output, 'release-candidate.json'), canonical(releaseMetadata));
    } else {
      await rm(releaseCandidatePath, { force: true });
      await rm(join(output, 'release-candidate.json'), { force: true });
      await writeFile(installedReleasePath, canonical(releaseMetadata));
    }
    for (const bundle of [app, recipient]) {
      for (const [key, value] of [['CFBundleVersion', String(config.sequence)], ['CFBundleShortVersionString', config.version]]) {
        run('/usr/bin/plutil', ['-replace', key, '-string', value, join(bundle, 'Contents/Info.plist')]);
      }
      if (isReleaseCandidate) run('/usr/bin/plutil', ['-insert', 'CFBundleDisplayName', '-string',
        'Private Provenance Release Candidate', join(bundle, 'Contents/Info.plist')]);
      await signBundle(bundle, config, work, bundle === app ? helper : null);
      const zip = join(work, `${bundle === app ? 'app' : 'verifier'}.zip`);
      run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', bundle, zip]);
      await notarize(zip, config.notaryProfile);
      run('/usr/bin/xcrun', ['stapler', 'staple', bundle]); run('/usr/bin/xcrun', ['stapler', 'validate', bundle]);
      run('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
    }
    if ((await sourceInventory(root)).sha256 !== sources.sha256) throw Error('Build inputs changed during signing');
    const provenance = { profile: 'pap-build-provenance/1', releaseChannel, releaseClass: isReleaseCandidate ? 'RELEASE_CANDIDATE' : 'PRODUCTION',
      storeListingVerified: config.storeListingVerified, source: sources, dependencyDigest,
      node: process.version, go: run(config.goExecutable, ['version']).trim(),
      swift: run('/usr/bin/xcrun', ['swiftc', '--version']).trim(), signature: 'DEVELOPER_ID', teamId: config.teamId,
      notarized: true, sourceRebuiltNativeTools: true,
      bundles: { application: await fileInventory(app), verifier: await fileInventory(recipient) } };
    const provenanceBytes = canonical(provenance);
    await writeFile(join(output, 'build-provenance.json'), provenanceBytes);
    const payload = join(work, 'payload'); await mkdir(payload);
    for (const [source, name] of [[app, 'Private Provenance.app'], [recipient, 'Private Provenance Verifier.app']]) {
      await cp(source, join(payload, name), { recursive: true });
    }
    for (const file of ['Install and remove.md', 'build-provenance.json', 'dependency-inventory.json',
      ...(isReleaseCandidate ? ['release-candidate.json'] : [])]) {
      await copyFile(join(output, file), join(payload, file));
    }
    const name = isReleaseCandidate
      ? `Private-Provenance-Release-Candidate-${config.version}-${config.sequence}.dmg`
      : `Private-Provenance-${config.version}-${config.sequence}.dmg`;
    const dmg = join(output, name);
    run('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-volname', 'Private Provenance', '-format', 'UDZO', dmg]);
    run('/usr/bin/codesign', ['--sign', config.signingIdentity, '--timestamp', dmg]);
    const notarization = await notarize(dmg, config.notaryProfile);
    run('/usr/bin/xcrun', ['stapler', 'staple', dmg]); run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    if (isReleaseCandidate) {
      const bytes = await readFile(dmg);
      await writeFile(join(output, 'notarization.json'), canonical(notarization));
      await writeFile(join(output, 'build-measurement.json'), canonical({ platform: 'darwin', arch: 'arm64',
        ...releasePlan, storeListingVerified: false, signature: 'DEVELOPER_ID', notarized: true,
        installedValidation: 'CANDIDATE_NOT_PRODUCTION',
        artifact: { name, bytes: bytes.length, sha256: sha256(bytes) } }));
      return { output, releaseReady: false, signed: true, notarized: true, ...releasePlan };
    }
    const bytes = await readFile(dmg), published = new Date();
    const release = validateRelease({ profile: RELEASE_PROFILE, sequence: config.sequence, version: config.version,
      platform: 'darwin-arm64', publishedAt: published.toISOString(), expiresAt: new Date(+published + 30 * 86400_000).toISOString(),
      readerVersion: 3, maximumSchema: 3, artifact: { name, bytes: bytes.length, sha256: sha256(bytes) },
      provenanceDigest: sha256(provenanceBytes), dependencyDigest });
    await writeFile(join(output, 'stable.json'), canonical({ release,
      signature: sign(null, Buffer.from(canonical(release)), privateKey).toString('base64url') }));
    await writeFile(join(output, 'notarization.json'), canonical(notarization));
    await writeFile(join(output, 'build-measurement.json'), canonical({ platform: 'darwin', arch: 'arm64',
      signature: 'DEVELOPER_ID', notarized: true, nativeHostManifestInstalled: false, installedValidation: 'REQUIRED' }));
    return { output, releaseReady: false, signed: true, notarized: true, releaseChannel,
      stableManifestCreated: true, installedValidation: 'REQUIRED' };
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , mode, first, second] = process.argv;
  if (!['--prepare', '--release', '--inventory'].includes(mode) || !first || (mode !== '--prepare' && !second)) {
    throw Error('Usage: build-macos.mjs --prepare NEW_OUTPUT | --release CONFIG NEW_OUTPUT | --inventory GO_EXECUTABLE NEW_FILE');
  }
  if (mode === '--inventory') {
    const inventory = await dependencyInventory(root, { goExecutable: resolve(first) });
    await writeFile(resolve(second), canonical(inventory), { flag: 'wx', mode: 0o600 });
    console.log(sha256(canonical(inventory)));
  } else buildDistribution(resolve(mode === '--prepare' ? first : second), mode === '--release'
    ? JSON.parse(await readFile(resolve(first), 'utf8')) : null).then(result => console.log(JSON.stringify(result)))
    .catch(() => { process.stderr.write('DISTRIBUTION_BUILD_FAILED: check release prerequisites and the isolated build directory.\n'); process.exitCode = 1; });
}
