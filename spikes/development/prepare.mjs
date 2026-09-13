import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fileInventory, sourceInventory } from '../distribution/inventory.mjs';
import { sha256 } from '../distribution/release.mjs';
import { canonical } from '../vault/format.mjs';
import { helperProfileFromPlist, readReleaseFile, validateHelperProfile } from '../distribution/release-inputs.mjs';
import { assertPortableExecutable } from '../recipient/build-macos.mjs';
import { assertNoPackagedLeaks } from '../distribution/artifact-files.mjs';
import { DEVELOPMENT_PROFILE, newDirectory, privateJSON, writeNewJSON } from './environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (command, args, options = {}) => execFileSync(command, args, {
  env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: 'pipe', timeout: 120000,
  maxBuffer: 4 * 1024 * 1024, ...options,
});
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = values => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(values)
  .map(([key, value]) => `<key>${xml(key)}</key>${value === true ? '<true/>' : Array.isArray(value)
    ? `<array>${value.map(item => `<string>${xml(item)}</string>`).join('')}</array>` : `<string>${xml(value)}</string>`}`)
  .join('')}</dict></plist>`;

export function validateDevelopmentConfig(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'helperProvisioningProfile,profile,signingIdentity,sponsor,teamId'
      || config.profile !== DEVELOPMENT_PROFILE || !/^[A-Z0-9]{10}$/.test(config.teamId)
      || typeof config.signingIdentity !== 'string' || !/^[A-F0-9]{40}$/.test(config.signingIdentity)
      || typeof config.helperProvisioningProfile !== 'string' || !config.helperProvisioningProfile.startsWith('/')) {
    throw Error('INVALID_PRIVATE_DEVELOPMENT_CONFIG');
  }
  if (config.sponsor !== null) {
    if (Object.keys(config.sponsor).sort().join(',') !== 'certificateFile,origin'
        || !/^https:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(config.sponsor.origin)
        || new URL(config.sponsor.origin).origin !== config.sponsor.origin
        || typeof config.sponsor.certificateFile !== 'string' || !config.sponsor.certificateFile.startsWith('/')) {
      throw Error('EXPLICIT_LOCAL_TLS_SPONSOR_REQUIRED');
    }
  }
  return config;
}

export async function prepareDevelopment(configPath, output) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('APPLE_SILICON_MAC_REQUIRED');
  const config = validateDevelopmentConfig(await privateJSON(configPath));
  const profileBytes = await readReleaseFile(config.helperProvisioningProfile, { limit: 1024 * 1024 });
  const decoded = run('/usr/bin/security', ['cms', '-D'], { input: profileBytes });
  const { appId, group } = validateHelperProfile(helperProfileFromPlist(decoded), config);
  const certificate = config.sponsor ? await readReleaseFile(config.sponsor.certificateFile, { limit: 8192 }) : null;
  if (certificate) {
    const cert = new X509Certificate(certificate);
    if (cert.checkIP('127.0.0.1') !== '127.0.0.1' || Date.parse(cert.validTo) <= Date.now()) {
      throw Error('INVALID_LOCAL_SPONSOR_CERTIFICATE');
    }
  }
  const sources = await sourceInventory(root);
  await newDirectory(output);
  const packageDirectory = join(output, 'package');
  run(process.execPath, [join(root, 'spikes/browser/chatgpt/build-macos.mjs'), packageDirectory]);
  const app = join(packageDirectory, 'Attestamp.app'), contents = join(app, 'Contents');
  const work = join(output, 'signing-work'); await mkdir(work, { mode: 0o700 });
  try {
    const helper = join(contents, 'Helpers/Private Provenance Keychain.app');
    const helperContents = join(helper, 'Contents');
    await mkdir(join(helperContents, 'MacOS'), { recursive: true });
    await rename(join(contents, 'MacOS/provenance-keychain-helper'), join(helperContents, 'MacOS/provenance-keychain-helper'));
    await writeFile(join(helperContents, 'Info.plist'), plist({ CFBundleIdentifier: 'ai.provenance.keychain-helper',
      CFBundleName: 'Attestamp Keychain', CFBundleExecutable: 'provenance-keychain-helper',
      CFBundlePackageType: 'APPL', CFBundleVersion: '1' }));
    await writeFile(join(helperContents, 'embedded.provisionprofile'), profileBytes);
    await writeFile(join(work, 'keychain.plist'), plist({ 'com.apple.application-identifier': appId,
      'com.apple.developer.team-identifier': config.teamId, 'keychain-access-groups': [group] }));
    await writeFile(join(work, 'node.plist'), plist({ 'com.apple.security.cs.allow-jit': true }));
    run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'swift-cache'), '-O',
      '-D', 'PRODUCT_CHATGPT', '-D', 'PRODUCT_RELEASE', '-D', 'PRIVATE_DEVELOPMENT', '-framework', 'Security',
      join(root, 'spikes/vault/native/macos-app-host.swift'), '-o', join(contents, 'MacOS/provenance-app-host')]);
    const dev = join(contents, 'Resources/spikes/development'); await mkdir(dev);
    for (const name of ['runtime.mjs', 'environment.mjs', 'tls.mjs', 'recovery.mjs']) {
      await copyFile(join(root, 'spikes/development', name), join(dev, name));
    }
    await writeNewJSON(join(dev, 'private-development.json'), { profile: DEVELOPMENT_PROFILE,
      sponsorOrigin: config.sponsor?.origin ?? null, assurance: 'PRIVATE_TESTNET_ONLY', updaterEnabled: false });
    if (certificate) await writeFile(join(dev, 'sponsor-certificate.pem'), certificate);
    run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName Attestamp Private Test', join(contents, 'Info.plist')]);
    const html = join(contents, 'Resources/spikes/browser/chatgpt/product.html');
    await writeFile(html, (await readFile(html, 'utf8')).replace('<body>',
      '<body><p role="note">PRIVATE DEVELOPMENT — TestNet only. Use synthetic test content in your dedicated account.</p>'));
    const sign = (path, identifier, entitlements) => run('/usr/bin/codesign', ['--force', '--sign', config.signingIdentity,
      '--timestamp=none', '--options', 'runtime', ...(identifier ? ['--identifier', identifier] : []),
      ...(entitlements ? ['--entitlements', entitlements] : []), path]);
    for (const bundle of [app, join(packageDirectory, 'Recipient/Attestamp Verifier.app')]) {
      await assertNoPackagedLeaks(bundle);
      for (const file of await fileInventory(bundle)) {
        if (!/Contents\/(MacOS\/|Resources\/spikes\/anchor\/algorand\/bin\/)/.test(file.path) || file.path.includes('/Helpers/')) continue;
        const path = join(bundle, file.path), name = file.path.split('/').at(-1);
        assertPortableExecutable(path);
        const ids = { node: bundle === app ? 'ai.provenance.consumer.runtime' : 'ai.provenance.verifier.runtime',
          'provenance-browser-host': 'ai.provenance.consumer.browser-host',
          'provenance-bridge-peer-validator': 'ai.provenance.consumer.bridge-peer-validator' };
        sign(path, ids[name], name === 'node' ? join(work, 'node.plist') : null);
      }
      if (bundle === app) sign(helper, null, join(work, 'keychain.plist'));
      sign(bundle);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
        `anchor apple generic and certificate leaf[subject.OU] = "${config.teamId}"`, bundle]);
    }
    await cp(join(root, 'spikes/browser/chatgpt/extension'), join(output, 'extension'), { recursive: true });
    await copyFile(join(root, 'spikes/development/README.md'), join(output, 'Start Here.md'));
    if ((await sourceInventory(root)).sha256 !== sources.sha256) throw Error('SOURCE_CHANGED_DURING_PRIVATE_BUILD');
    const inventory = { application: await fileInventory(app),
      verifier: await fileInventory(join(packageDirectory, 'Recipient/Attestamp Verifier.app')),
      extension: await fileInventory(join(output, 'extension')) };
    await writeNewJSON(join(output, 'private-inventory.json'), inventory);
    await writeNewJSON(join(output, 'private-build.json'), { profile: DEVELOPMENT_PROFILE,
      releaseClass: 'PRIVATE_DEVELOPMENT', sourceDigest: sources.sha256,
      signature: 'DEVELOPER_ID_WITHOUT_NOTARIZATION', notarized: false, storeDistributed: false,
      updaterEnabled: false, installedAcceptance: 'NOT_RUN',
      bundleInventoryDigest: sha256(canonical(inventory)) });
    return { profile: DEVELOPMENT_PROFILE, prepared: true, installedAcceptance: 'NOT_RUN' };
  } finally { await rm(work, { recursive: true, force: true }); }
}
