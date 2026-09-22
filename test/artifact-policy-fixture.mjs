import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { canonical } from '../spikes/vault/format.mjs';
import { fileInventory, shippingGoBuildPlan } from '../spikes/distribution/inventory.mjs';
import { sha256 } from '../spikes/distribution/release.mjs';
import { verifyDistribution } from '../spikes/distribution/verify-artifacts.mjs';

export const app = 'Attestamp.app', verifier = 'Recipient/Attestamp Verifier.app';
export const resources = `${app}/Contents/Resources`, distribution = `${resources}/spikes/distribution`;
export const extension = `${resources}/spikes/browser/chatgpt/extension`;
export const helper = `${app}/Contents/Helpers/Private Provenance Keychain.app`;
export const now = Date.parse('2026-09-12T12:00:00.000Z');
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};

export function zip(entries, { compressed = false, descriptor = false } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const path = Buffer.from(name), bytes = Buffer.from(content), packed = compressed ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46), crc = crc32(bytes);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(descriptor ? 8 : 0, 6);
    header.writeUInt16LE(compressed ? 8 : 0, 8); header.writeUInt16LE(path.length, 26);
    if (!descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); }
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(descriptor ? 8 : 0, 8); directory.writeUInt16LE(compressed ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(path.length, 28); directory.writeUInt32LE(offset, 42);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) { trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(crc, 4); trailer.writeUInt32LE(packed.length, 8); trailer.writeUInt32LE(bytes.length, 12); }
    locals.push(header, path, packed, trailer); central.push(directory, path); offset += header.length + path.length + packed.length + trailer.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const plist = values => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(values)
  .map(([k, v]) => `<key>${k}</key>${typeof v === 'boolean' ? `<${v}/>` : `<string>${v}</string>`}`).join('')}</dict></plist>`;
const tree = items => {
  const files = Object.entries(items).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256(text) }));
  return { sha256: sha256(canonical(files)), files };
};

export async function fixture(t, channel = 'release-candidate') {
  const directory = await realpath(await mkdtemp('/private/tmp/provenance-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'prepared-test-output'); await mkdir(output);
  const write = async (path, bytes) => { await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes, { mode: /\/(?:MacOS|bin)\//.test(path) ? 0o700 : 0o600 }); };
  const json = (path, value) => write(path, canonical(value));
  const readJSON = async path => JSON.parse(await readFile(join(output, path)));
  const signed = channel !== 'development', candidate = channel === 'release-candidate';
  const key = generateKeyPairSync('ed25519');
  const values = { sequence: 4, version: '1.2.0', teamId: 'TESTTEAM01', updateOrigin: 'https://updates.example.invalid',
    updatePublicKey: key.publicKey.export({ format: 'jwk' }).x };
  const metadata = signed ? { profile: candidate ? 'pap-release-candidate/1' : 'pap-installed-release/1',
    ...(candidate ? { releaseChannel: channel } : {}), ...values, storeListingVerified: !candidate } : null;
  const binaries = 'Synthetic non-executable file; artifact inspection must never run it.';
  for (const [bundle, id, executable, name] of [[app, 'ai.provenance.consumer.host', 'provenance-app-host', 'Attestamp'],
    [verifier, 'ai.provenance.verifier.host', 'provenance-verifier-host', 'Attestamp Verifier'],
    ...(signed ? [[helper, 'ai.provenance.keychain-helper', 'provenance-keychain-helper', 'Attestamp Keychain']] : [])]) {
    await write(`${bundle}/Contents/Info.plist`, plist({ CFBundleIdentifier: id, CFBundleExecutable: executable, CFBundleName: name,
      CFBundlePackageType: 'APPL', CFBundleVersion: String(signed ? values.sequence : 1),
      ...(bundle === helper ? { CFBundleDisplayName: name } : { LSMinimumSystemVersion: '15.7', LSUIElement: true,
        ...(signed ? { CFBundleShortVersionString: values.version } : {}), ...(candidate ? { CFBundleDisplayName: `${name} Release Candidate` } : {}) }) }));
    await write(`${bundle}/Contents/MacOS/${executable}`, binaries);
    if (bundle !== helper) {
      await write(`${bundle}/Contents/MacOS/node`, binaries); await write(`${bundle}/Contents/Resources/Node-LICENSE.txt`, 'Synthetic Node license');
      await write(`${bundle}/Contents/Resources/THIRD_PARTY_NOTICES.md`, 'Synthetic notices');
    }
  }
  for (const name of ['provenance-browser-host', 'provenance-bridge-peer-validator', ...(!signed ? ['provenance-keychain-helper'] : [])]) {
    await write(`${app}/Contents/MacOS/${name}`, binaries);
  }
  for (const name of ['verify', 'fast-verify', 'fast-observe']) await write(`${resources}/spikes/anchor/algorand/bin/${name}`, binaries);
  await write(`${verifier}/Contents/Resources/spikes/anchor/algorand/bin/verify`, binaries);
  if (signed) await write(`${helper}/Contents/embedded.provisionprofile`, 'Synthetic public provisioning profile');
  const manifest = JSON.parse(await readFile(new URL('../spikes/browser/chatgpt/extension/manifest.json', import.meta.url)));
  const sourceBytes = new Map([['spikes/anchor/algorand/go.mod', 'module synthetic-artifact-test\ngo 1.25.1\n'],
    ['spikes/anchor/algorand/go.sum', ''], ['spikes/distribution/THIRD_PARTY_NOTICES.md', 'Synthetic notices'],
    ['spikes/browser/chatgpt/extension/manifest.json', canonical(manifest)]]);
  for (const path of ['browser/chatgpt/bridge-runtime.mjs', 'browser/chatgpt/dashboard.html', 'distribution/config.mjs', 'distribution/updater.mjs',
    'distribution/lifecycle.mjs', 'browser/chatgpt/adapter.mjs', 'managed/client.mjs', 'managed/protocol.mjs']) {
    sourceBytes.set(`spikes/${path}`, `// Synthetic approved source for ${path}\n`);
  }
  sourceBytes.set('spikes/browser/chatgpt/runtime-main.mjs', "import './bridge-runtime.mjs';\n");
  // Keep the synthetic producer independent of the verifier's resource list.
  const recipientSources = ['vault/format.mjs', 'vault/records.mjs', 'anchor/verifier.mjs', 'anchor/merkle.mjs', 'anchor/native-verifier.mjs',
    'recipient/portable.mjs', 'recipient/normal-observation.mjs', 'recipient/chatgpt-route.mjs', 'recipient/strict-observation.mjs', 'recipient/qualified-observation.mjs', 'recipient/dom-observation.mjs', 'recipient/legacy-observation.mjs', 'recipient/verify.mjs', 'recipient/server.mjs', 'recipient/main.mjs',
    'recipient/recipient.html', 'recipient/recipient.js', 'recipient/recipient.css'];
  for (const path of recipientSources) {
    const bytes = path === 'recipient/main.mjs' ? "import './server.mjs';\n" : `// Synthetic approved source for ${path}\n`;
    sourceBytes.set(`spikes/${path}`, bytes);
    await write(`${verifier}/Contents/Resources/spikes/${path}`, bytes);
  }
  for (const path of ['service-worker.js', 'content-script.js', 'fetch-observer.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel-model.js', 'sidepanel-channel.js', 'sidepanel.css',
    ...Object.values(manifest.icons)]) sourceBytes.set(`spikes/browser/chatgpt/extension/${path}`, 'Synthetic extension bytes');
  for (const [path, bytes] of sourceBytes) await write(`${resources}/${path}`, bytes);
  const source = { files: [...sourceBytes].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })).sort((a, b) => a.path < b.path ? -1 : 1) };
  source.sha256 = sha256(canonical(source.files));
  const policy = { releaseChannel: channel, sourceDigest: source.sha256, ...(signed ? values : {}) };
  const storeEntries = [...sourceBytes].filter(([path]) => path.startsWith('spikes/browser/chatgpt/extension/'))
    .map(([path, bytes]) => [path.slice('spikes/browser/chatgpt/extension/'.length), bytes]);
  const { key: ignored, ...upload } = manifest; storeEntries.find(([name]) => name === 'manifest.json')[1] = canonical(upload);
  await write('Chrome-Web-Store-upload.zip', zip(storeEntries));
  await json('NativeMessagingHosts/ai.provenance.consumer.json', { name: 'ai.provenance.consumer',
    description: 'Private Provenance fixed-purpose ChatGPT bridge', path: `${output}/${app}/Contents/MacOS/provenance-browser-host`,
    type: 'stdio', allowed_origins: ['chrome-extension://medilhopfckldjgdnchfkpmfmfnkadca/'] });
  for (const path of ['Start Here.md', 'Install and remove.md', 'Recipient/Verify locally.md']) await write(path, candidate
    ? '# ATTESTAMP RELEASE CANDIDATE — PRE-PUBLICATION REVIEW ONLY\nSynthetic guide' : 'Synthetic Attestamp guide');
  await json(`${distribution}/installed-release.json`, candidate || !signed ? null : metadata);
  if (candidate) { await json(`${distribution}/release-candidate.json`, metadata); await json('release-candidate.json', metadata); }
  const goFiles = { 'bin/go': binaries, LICENSE: 'Synthetic Go license', PATENTS: 'Synthetic Go patents', VERSION: 'go1.27.1',
    'go.env': 'Synthetic defaults', 'src/runtime/runtime.go': 'Synthetic source', 'pkg/include/textflag.h': 'Synthetic header',
    'lib/time/zoneinfo.zip': 'Synthetic library', ...Object.fromEntries(['compile', 'link', 'asm', 'cgo'].map(name => [`pkg/tool/darwin_arm64/${name}`, binaries])) };
  const inventory = { profile: 'pap-dependency-inventory/2', javascriptPackages: [],
    node: { version: 'v24.21.0', sha256: sha256(binaries), components: { node: '24.21.0' }, licenseSha256: sha256('Synthetic Node license') },
    goToolchain: signed ? { sha256: sha256(binaries), version: 'go version go1.27.1 darwin/arm64',
      licenseSha256: sha256(goFiles.LICENSE), patentsSha256: sha256(goFiles.PATENTS), inputs: tree(goFiles) } : null,
    goBuild: { ...shippingGoBuildPlan(), inputs: tree({ 'go.mod': sourceBytes.get('spikes/anchor/algorand/go.mod'), 'go.sum': '' }) },
    noticesDigest: sha256('Synthetic notices'), goModDigest: sha256(sourceBytes.get('spikes/anchor/algorand/go.mod')), goSumDigest: sha256(''),
    modules: [], reviewScope: 'Synthetic independent fixture, never release approval.' };
  await json('dependency-inventory.json', inventory);
  const provenance = { profile: 'pap-build-provenance/1', releaseChannel: channel,
    releaseClass: signed ? candidate ? 'RELEASE_CANDIDATE' : 'PRODUCTION' : 'DEVELOPMENT',
    signature: signed ? 'DEVELOPER_ID' : 'AD_HOC_ONLY', notarized: signed, sourceRebuiltNativeTools: signed,
    source, dependencyDigest: sha256(canonical(inventory)), ...(signed ? { storeListingVerified: !candidate,
      node: inventory.node.version, go: inventory.goToolchain.version, swift: 'Synthetic Swift compiler', teamId: values.teamId }
      : { storeListing: 'NOT_PROVISIONED', manualMeasurements: { osPermissionSteps: null, storePermissionSteps: null, installedPairingMs: null } }) };
  const artifactName = signed ? candidate ? 'Attestamp-Release-Candidate-1.2.0-4.dmg' : 'Private-Provenance-1.2.0-4.dmg' : null;
  const artifactBytes = Buffer.from('Synthetic opaque disk image; no Apple signature or install evidence');
  const artifact = { name: artifactName, bytes: artifactBytes.length, sha256: sha256(artifactBytes) };
  if (signed) {
    await write(artifactName, artifactBytes); await json('notarization.json', { id: '00000000-0000-4000-8000-000000000001', status: 'Accepted' });
  }
  await json('build-measurement.json', signed ? { platform: 'darwin', arch: 'arm64', releaseChannel: channel,
    releaseClass: provenance.releaseClass, stableManifestCreated: !candidate, updaterEnabled: !candidate, installedProductionState: !candidate,
    artifactName, stableManifest: candidate ? null : 'stable.json', bundledInstalledRelease: candidate ? null : 'installed-release.json',
    updaterAvailable: !candidate, promotion: candidate ? 'FRESH_PRODUCTION_BUILD_REQUIRED' : 'PRODUCTION_RELEASE',
    signature: 'DEVELOPER_ID', notarized: true, installedValidation: candidate ? 'CANDIDATE_NOT_PRODUCTION' : 'REQUIRED',
    ...(candidate ? { storeListingVerified: false, artifact } : { nativeHostManifestInstalled: false }) }
    : { platform: 'darwin', arch: 'arm64', node: inventory.node.version, buildMs: 1, signature: 'AD_HOC_ONLY', notarized: false,
      storeDistributed: false, nativeHostManifestInstalled: false });
  const release = { profile: 'pap-desktop-release/1', sequence: values.sequence, version: values.version, platform: 'darwin-arm64',
    publishedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString(),
    readerVersion: 3, maximumSchema: 3, artifact, provenanceDigest: '', dependencyDigest: provenance.dependencyDigest };
  const signStable = () => json('stable.json', { release, signature: sign(null, Buffer.from(canonical(release)), key.privateKey).toString('base64url') });
  const seal = async () => {
    provenance.bundles = { application: await fileInventory(join(output, app)), verifier: await fileInventory(join(output, verifier)) };
    await json('build-provenance.json', provenance);
    if (channel === 'production') { release.provenanceDigest = sha256(canonical(provenance)); await signStable(); }
  };
  await seal();
  return { directory, output, policy, source, provenance, inventory, metadata, artifact, release, key, storeEntries,
    write, json, readJSON, seal, signStable, run: () => verifyDistribution(output, policy, { now }) };
}
