import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonical, keys, parseCanonical } from '../vault/format.mjs';
import { validateInstalledRelease, validateReleaseCandidate } from './config.mjs';
import { releaseArtifactContract, readReleaseFile } from './release-inputs.mjs';
import { shippingGoBuildPlan } from './inventory.mjs';
import { sha256, verifyRelease } from './release.mjs';
import { leakDiagnostic } from './package-leaks.mjs';
import { copyApplicationResource, generatedSourceResources, recipientSourceResources } from './package-resources.mjs';
import { artifactJSON, artifactSnapshot, bundleInfo, requireArtifact as require, safeRelative,
  snapshotIdentity, storeArchive } from './artifact-files.mjs';

const APPLICATION = 'Attestamp.app', VERIFIER = 'Recipient/Attestamp Verifier.app';
const RESOURCES = `${APPLICATION}/Contents/Resources`, DISTRIBUTION = `${RESOURCES}/spikes/distribution`;
const HELPER = `${APPLICATION}/Contents/Helpers/Private Provenance Keychain.app`;
const EXTENSION = `${RESOURCES}/spikes/browser/chatgpt/extension`;
const STORE_ID = 'medilhopfckldjgdnchfkpmfmfnkadca';
const checks = ['EXPECTED_POLICY', 'OUTPUT_FILES', 'CHANNEL_CONTRACT', 'INVENTORY_LINKAGE',
  'BUNDLE_IDENTITIES', 'STORE_PACKAGE', 'PRODUCTION_SIGNATURE', 'INPUT_STABILITY'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => require(canonical(a) === canonical(b));
const reportBase = () => ({ profile: 'pap-artifact-policy-verification/1', status: 'FAILED', releaseChannel: null,
  sourceDigest: null, dependencyDigest: null, updaterEnabled: null, failure: null, packageLeak: null, releaseReady: false,
  appleTrust: 'NOT_CHECKED', diskImageContents: 'NOT_INSPECTED',
  checks: checks.map(check => ({ check, status: 'NOT_RUN' })) });

function validatePolicy(policy) {
  require(['development', 'release-candidate', 'production'].includes(policy?.releaseChannel) && digest(policy.sourceDigest));
  keys(policy, ['releaseChannel', 'sourceDigest', ...(policy.releaseChannel === 'development' ? []
    : ['sequence', 'version', 'teamId', 'updateOrigin', 'updatePublicKey'])]);
  if (policy.releaseChannel === 'development') return null;
  const { releaseChannel, sourceDigest, ...values } = policy;
  return releaseChannel === 'production'
    ? validateInstalledRelease({ profile: 'pap-installed-release/1', ...values, storeListingVerified: true })
    : validateReleaseCandidate({ profile: 'pap-release-candidate/1', releaseChannel, ...values, storeListingVerified: false });
}

function inventoryEntries(entries, { source = false } = {}) {
  require(Array.isArray(entries) && entries.length > 0 && entries.length <= 50_000);
  const seen = new Set();
  for (const item of entries) {
    keys(item, source ? ['path', 'sha256'] : ['path', 'bytes', 'sha256']);
    require(safeRelative(item.path) && !seen.has(item.path.toLowerCase()) && digest(item.sha256));
    if (!source) require(Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 1024 ** 3);
    seen.add(item.path.toLowerCase());
  }
  return new Map(entries.map(item => [item.path, item]));
}

function treeInventory(tree) {
  keys(tree, ['sha256', 'files']); require(digest(tree.sha256) && sha256(canonical(tree.files)) === tree.sha256);
  return inventoryEntries(tree.files);
}

function validateDependencies(inventory, sourceFiles, signed) {
  keys(inventory, ['profile', 'javascriptPackages', 'node', 'goToolchain', 'goBuild', 'noticesDigest',
    'goModDigest', 'goSumDigest', 'modules', 'reviewScope']);
  require(inventory.profile === 'pap-dependency-inventory/2'); same(inventory.javascriptPackages, []);
  keys(inventory.node, ['version', 'sha256', 'components', 'licenseSha256']);
  require(/^v\d+\.\d+\.\d+$/.test(inventory.node.version) && digest(inventory.node.sha256) && digest(inventory.node.licenseSha256)
    && inventory.node.components?.node === inventory.node.version.slice(1));
  for (const [field, path] of [['goModDigest', 'spikes/anchor/algorand/go.mod'], ['goSumDigest', 'spikes/anchor/algorand/go.sum'],
    ['noticesDigest', 'spikes/distribution/THIRD_PARTY_NOTICES.md']]) require(inventory[field] === sourceFiles.get(path)?.sha256);
  const { inputs, ...plan } = inventory.goBuild; same(plan, shippingGoBuildPlan());
  const goInputs = treeInventory(inputs);
  for (const [path, item] of sourceFiles) {
    if (path.startsWith('spikes/anchor/algorand/')) {
      require(goInputs.get(path.slice('spikes/anchor/algorand/'.length))?.sha256 === item.sha256);
    }
  }
  require(goInputs.get('go.mod')?.sha256 === inventory.goModDigest && goInputs.get('go.sum')?.sha256 === inventory.goSumDigest);
  require(Array.isArray(inventory.modules));
  const modules = new Set();
  for (const item of inventory.modules) {
    keys(item, ['name', 'version', 'checksum']);
    require(typeof item.name === 'string' && !modules.has(item.name) && /^v\d+\./.test(item.version)
      && /^h1:[A-Za-z0-9+/]{43}=$/.test(item.checksum)); modules.add(item.name);
  }
  if (!signed) { require(inventory.goToolchain === null); return; }
  const toolchain = inventory.goToolchain;
  keys(toolchain, ['sha256', 'version', 'inputs', 'licenseSha256', 'patentsSha256']);
  require(/^go version go\d+\.\d+(?:\.\d+)? darwin\/arm64$/.test(toolchain.version));
  const files = treeInventory(toolchain.inputs);
  for (const [field, path] of [['sha256', 'bin/go'], ['licenseSha256', 'LICENSE'], ['patentsSha256', 'PATENTS']]) {
    require(digest(toolchain[field]) && files.get(path)?.sha256 === toolchain[field]);
  }
  for (const path of ['go.env', 'VERSION', ...['compile', 'link', 'asm', 'cgo'].map(name => `pkg/tool/darwin_arm64/${name}`)]) require(files.has(path));
  for (const prefix of ['src/', 'pkg/include/', 'lib/']) require([...files.keys()].some(path => path.startsWith(prefix)));
}

function bundleFiles(snapshot, bundle) {
  return [...snapshot.files].filter(([path]) => path.startsWith(`${bundle}/`))
    .map(([path, item]) => ({ path: path.slice(bundle.length + 1), bytes: item.bytes, sha256: item.sha256 }));
}

function validateProvenance(provenance, inventory, snapshot, policy, signed) {
  keys(provenance, ['profile', 'releaseChannel', 'releaseClass', 'signature', 'notarized', 'source', 'dependencyDigest',
    'sourceRebuiltNativeTools', 'bundles', ...(signed ? ['storeListingVerified', 'node', 'go', 'swift', 'teamId']
      : ['storeListing', 'manualMeasurements'])]);
  require(provenance.profile === 'pap-build-provenance/1' && provenance.source.sha256 === policy.sourceDigest);
  keys(provenance.source, ['sha256', 'files']);
  const source = inventoryEntries(provenance.source.files, { source: true });
  require(sha256(canonical(provenance.source.files)) === policy.sourceDigest
    && provenance.dependencyDigest === sha256(canonical(inventory)));
  keys(provenance.bundles, ['application', 'verifier']);
  for (const [name, path] of [['application', APPLICATION], ['verifier', VERIFIER]]) {
    inventoryEntries(provenance.bundles[name]); same(provenance.bundles[name], bundleFiles(snapshot, path));
  }
  validateDependencies(inventory, source, signed);
  if (signed) require(provenance.node === inventory.node.version && provenance.go === inventory.goToolchain.version
    && typeof provenance.swift === 'string' && provenance.swift.length > 0 && provenance.swift.length < 2048);
  for (const bundle of [APPLICATION, VERIFIER]) {
    const resources = `${bundle}/Contents/Resources/`;
    require(snapshot.files.get(`${resources}Node-LICENSE.txt`)?.sha256 === inventory.node.licenseSha256
      && snapshot.files.get(`${resources}THIRD_PARTY_NOTICES.md`)?.sha256 === inventory.noticesDigest);
    const recipient = bundle === VERIFIER;
    const generated = new Set(generatedSourceResources(recipient, policy.releaseChannel));
    const copied = new Set(recipient ? recipientSourceResources
      : [...source.keys()].filter(path => copyApplicationResource(path) && !generated.has(path)));
    // An inventory of present files cannot prove completeness. Derive the exact
    // required resources from authenticated source and the trusted copy contract.
    for (const path of copied) require(source.has(path)
      && snapshot.files.get(`${resources}${path}`)?.sha256 === source.get(path).sha256);
    for (const path of generated) require(snapshot.files.has(`${resources}${path}`));
    for (const [path, item] of snapshot.files) {
      if (!path.startsWith(`${resources}spikes/`)) continue;
      const original = path.slice(resources.length);
      require(generated.has(original) || copied.has(original) && source.get(original)?.sha256 === item.sha256);
    }
  }
  // Updater policy is meaningful only with the runtime/config code bound to the
  // independently supplied source digest. Merely finding a null marker is insufficient.
  for (const path of ['browser/chatgpt/runtime-main.mjs', 'distribution/config.mjs', 'distribution/updater.mjs',
    'distribution/lifecycle.mjs', 'browser/chatgpt/adapter.mjs']) {
    require(snapshot.files.get(`${RESOURCES}/spikes/${path}`)?.sha256 === source.get(`spikes/${path}`)?.sha256
      && source.has(`spikes/${path}`));
  }
}

function validateLayout(snapshot, signed, candidate, artifactName) {
  const topFiles = new Set(['dependency-inventory.json', 'build-provenance.json', 'build-measurement.json',
    'Chrome-Web-Store-upload.zip', 'Install and remove.md', 'Start Here.md', 'Recipient/Verify locally.md',
    'NativeMessagingHosts/ai.provenance.consumer.json', ...(signed ? ['notarization.json', artifactName,
      candidate ? 'release-candidate.json' : 'stable.json'] : [])]);
  for (const path of topFiles) require(snapshot.files.has(path));
  for (const path of snapshot.files.keys()) {
    require(topFiles.has(path) || [APPLICATION, VERIFIER].some(bundle => path.startsWith(`${bundle}/Contents/`)));
    if (!topFiles.has(path)) require([APPLICATION, VERIFIER, ...(signed ? [HELPER] : [])].some(bundle => {
      const suffix = path.startsWith(`${bundle}/Contents/`) ? path.slice(`${bundle}/Contents/`.length) : '';
      return ['Info.plist', '_CodeSignature/CodeResources', ...(bundle === HELPER ? ['embedded.provisionprofile'] :
        ['Resources/Node-LICENSE.txt', 'Resources/THIRD_PARTY_NOTICES.md'])].includes(suffix)
        || suffix.startsWith('MacOS/') || bundle !== HELPER && suffix.startsWith('Resources/spikes/');
    }));
    const name = path.split('/').at(-1);
    if (['stable.json', 'release-candidate.json', 'installed-release.json', 'build-provenance.json', 'dependency-inventory.json',
      'build-measurement.json', 'notarization.json'].includes(name)) {
      require(topFiles.has(path) || path === `${DISTRIBUTION}/installed-release.json`
        || candidate && path === `${DISTRIBUTION}/release-candidate.json`);
    }
  }
  // Reject empty staging/extra bundle directories as well as extra files.
  for (const path of snapshot.directories.keys()) require(path === '' || [...snapshot.files.keys()].some(file => file.startsWith(`${path}/`)));
}

function validateBundleIdentities(snapshot, bytes, metadata, signed, candidate) {
  const expected = [[APPLICATION, 'ai.provenance.consumer.host', 'provenance-app-host', 'Attestamp'],
    [VERIFIER, 'ai.provenance.verifier.host', 'provenance-verifier-host', 'Attestamp Verifier']];
  if (signed) expected.push([HELPER, 'ai.provenance.keychain-helper', 'provenance-keychain-helper', 'Attestamp Keychain']);
  for (const [path, id, executable, name] of expected) {
    const info = bundleInfo(bytes(`${path}/Contents/Info.plist`));
    keys(info, ['CFBundleIdentifier', 'CFBundleExecutable', 'CFBundleName', 'CFBundlePackageType', 'CFBundleVersion',
      ...(path === HELPER ? ['CFBundleDisplayName'] : ['LSMinimumSystemVersion', 'LSUIElement',
        ...(signed ? ['CFBundleShortVersionString'] : []), ...(Object.hasOwn(info, 'CFBundleDisplayName') ? ['CFBundleDisplayName'] : [])])]);
    require(info.CFBundleIdentifier === id && info.CFBundleExecutable === executable && info.CFBundleName === name
      && info.CFBundlePackageType === 'APPL' && info.CFBundleVersion === String(signed ? metadata.sequence : 1)
      && snapshot.files.get(`${path}/Contents/MacOS/${executable}`)?.bytes > 0);
    if (path === HELPER) require(info.CFBundleDisplayName === name);
    else {
      require(info.LSMinimumSystemVersion === '15.7' && info.LSUIElement === true);
      require(signed ? info.CFBundleShortVersionString === metadata.version : !Object.hasOwn(info, 'CFBundleShortVersionString'));
      require(candidate ? info.CFBundleDisplayName === `${name} Release Candidate`
        : !Object.hasOwn(info, 'CFBundleDisplayName') || info.CFBundleDisplayName === name);
    }
  }
  const executables = new Set([`${APPLICATION}/Contents/MacOS/provenance-app-host`,
    ...['node', 'provenance-browser-host', 'provenance-bridge-peer-validator'].map(name => `${APPLICATION}/Contents/MacOS/${name}`),
    `${signed ? HELPER : APPLICATION}/Contents/MacOS/provenance-keychain-helper`,
    ...['node', 'provenance-verifier-host'].map(name => `${VERIFIER}/Contents/MacOS/${name}`),
    ...['verify', 'fast-verify', 'fast-observe'].map(name => `${RESOURCES}/spikes/anchor/algorand/bin/${name}`),
    `${VERIFIER}/Contents/Resources/spikes/anchor/algorand/bin/verify`]);
  for (const path of executables) require(snapshot.files.get(path)?.bytes > 0 && (snapshot.files.get(path).mode & 0o100));
  for (const path of snapshot.files.keys()) {
    if (path.includes('/MacOS/') || path.includes('/bin/')) require(executables.has(path));
    if (path.endsWith('/Info.plist')) require(expected.some(([bundle]) => path === `${bundle}/Contents/Info.plist`));
    if (path.endsWith('.provisionprofile')) require(signed && path === `${HELPER}/Contents/embedded.provisionprofile`);
    if (path.includes('/Helpers/')) require(signed && path.startsWith(`${HELPER}/Contents/`));
  }
  require(signed ? snapshot.files.get(`${HELPER}/Contents/embedded.provisionprofile`)?.bytes > 0
    : ![...snapshot.files.keys()].some(path => path.startsWith(`${HELPER}/`)));
}

function validateStore(snapshot, bytes) {
  const manifest = artifactJSON(bytes(`${EXTENSION}/manifest.json`));
  require(typeof manifest.key === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key));
  const decoded = Buffer.from(manifest.key, 'base64'); require(decoded.toString('base64') === manifest.key);
  const id = sha256(decoded).slice(0, 32).replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + parseInt(nibble, 16)));
  require(id === STORE_ID && manifest.manifest_version === 3 && manifest.incognito === 'not_allowed');
  same(manifest.permissions, ['nativeMessaging', 'sidePanel']); same(manifest.host_permissions, ['https://chatgpt.com/*']);
  same(manifest.side_panel, { default_path: 'sidepanel.html' });
  same(manifest.action, { default_title: 'Open Attestamp' });
  same(manifest.content_security_policy, { extension_pages: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  for (const name of ['sidepanel.html', 'sidepanel.js', 'sidepanel-model.js', 'sidepanel.css']) require(bytes(`${EXTENSION}/${name}`).length > 0);
  require(!manifest.optional_permissions && !manifest.optional_host_permissions && !manifest.externally_connectable
    && !manifest.web_accessible_resources && !manifest.update_url);
  const native = artifactJSON(bytes('NativeMessagingHosts/ai.provenance.consumer.json'));
  keys(native, ['name', 'description', 'path', 'type', 'allowed_origins']);
  require(native.name === 'ai.provenance.consumer' && native.type === 'stdio'
    && native.description === 'Private Provenance fixed-purpose ChatGPT bridge'
    && typeof native.path === 'string' && native.path.startsWith('/') && resolve(native.path) === native.path
    && native.path.endsWith(`/${APPLICATION}/Contents/MacOS/provenance-browser-host`));
  same(native.allowed_origins, [`chrome-extension://${STORE_ID}/`]);
  const archive = storeArchive(bytes('Chrome-Web-Store-upload.zip'));
  const { key, ...upload } = manifest; same(artifactJSON(archive.get('manifest.json')), upload);
  const expected = [...snapshot.files.keys()].filter(path => path.startsWith(`${EXTENSION}/`)).map(path => path.slice(EXTENSION.length + 1));
  same([...archive.keys()].sort(), expected.sort());
  for (const path of expected) if (path !== 'manifest.json') require(archive.get(path).equals(bytes(`${EXTENSION}/${path}`)));
  for (const size of ['16', '32', '48', '128']) {
    const path = manifest.icons?.[size]; require(safeRelative(path) && archive.get(path)?.length > 0);
  }
}

export async function verifyDistribution(directory, policy, { now = Date.now() } = {}) {
  const report = reportBase(); let active;
  const check = async (name, action) => {
    active = report.checks.find(item => item.check === name);
    const result = await action(); active.status = 'PASSED'; return result;
  };
  try {
    const metadata = await check('EXPECTED_POLICY', () => { require(Number.isFinite(now)); return validatePolicy(policy); });
    report.releaseChannel = policy.releaseChannel;
    const signed = metadata !== null, candidate = policy.releaseChannel === 'release-candidate';
    const contract = signed ? releaseArtifactContract({ ...metadata, releaseChannel: policy.releaseChannel }) : null;
    const snapshot = await check('OUTPUT_FILES', () => artifactSnapshot(resolve(directory)));
    const bytes = path => { const content = snapshot.files.get(path)?.content; require(content); return content; };
    const json = path => artifactJSON(bytes(path));
    let provenance, inventory, stable;
    await check('CHANNEL_CONTRACT', () => {
      validateLayout(snapshot, signed, candidate, contract?.artifactName);
      provenance = parseCanonical(bytes('build-provenance.json'), 16 * 1024 * 1024);
      inventory = parseCanonical(bytes('dependency-inventory.json'), 16 * 1024 * 1024);
      require(provenance.releaseChannel === policy.releaseChannel
        && provenance.releaseClass === (signed ? contract.releaseClass : 'DEVELOPMENT')
        && provenance.signature === (signed ? 'DEVELOPER_ID' : 'AD_HOC_ONLY')
        && provenance.notarized === signed && provenance.sourceRebuiltNativeTools === signed);
      const installed = json(`${DISTRIBUTION}/installed-release.json`), measurement = json('build-measurement.json');
      require(measurement.platform === 'darwin' && measurement.arch === 'arm64'
        && measurement.signature === provenance.signature && measurement.notarized === signed);
      if (!signed) {
        require(installed === null && provenance.storeListing === 'NOT_PROVISIONED');
        same(provenance.manualMeasurements, { osPermissionSteps: null, storePermissionSteps: null, installedPairingMs: null });
        keys(measurement, ['platform', 'arch', 'node', 'buildMs', 'signature', 'notarized', 'storeDistributed', 'nativeHostManifestInstalled']);
        require(measurement.storeDistributed === false && measurement.nativeHostManifestInstalled === false
          && measurement.node === inventory.node.version && Number.isFinite(measurement.buildMs) && measurement.buildMs >= 0);
      } else {
        require(provenance.teamId === metadata.teamId && provenance.storeListingVerified === !candidate);
        keys(measurement, ['platform', 'arch', ...Object.keys(contract), 'signature', 'notarized', 'installedValidation',
          ...(candidate ? ['storeListingVerified', 'artifact'] : ['nativeHostManifestInstalled'])]);
        for (const [key, value] of Object.entries(contract)) same(measurement[key], value);
        const notarization = json('notarization.json'); keys(notarization, ['id', 'status']);
        require(notarization.status === 'Accepted' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(notarization.id));
        require(snapshot.files.get(contract.artifactName).bytes > 0);
        if (candidate) {
          require(installed === null && measurement.storeListingVerified === false && measurement.installedValidation === 'CANDIDATE_NOT_PRODUCTION');
          same(json('release-candidate.json'), metadata); same(json(`${DISTRIBUTION}/release-candidate.json`), metadata);
          keys(measurement.artifact, ['name', 'bytes', 'sha256']);
          const artifact = snapshot.files.get(contract.artifactName);
          same(measurement.artifact, { name: contract.artifactName, bytes: artifact.bytes, sha256: artifact.sha256 });
          for (const path of ['Install and remove.md', 'Start Here.md']) require(bytes(path).toString('utf8')
            .startsWith('# ATTESTAMP RELEASE CANDIDATE — PRE-PUBLICATION REVIEW ONLY\n'));
        } else {
          same(installed, metadata);
          require(measurement.nativeHostManifestInstalled === false && measurement.installedValidation === 'REQUIRED');
          stable = bytes('stable.json');
        }
      }
    });
    await check('INVENTORY_LINKAGE', () => validateProvenance(provenance, inventory, snapshot, policy, signed));
    await check('BUNDLE_IDENTITIES', () => validateBundleIdentities(snapshot, bytes, metadata, signed, candidate));
    await check('STORE_PACKAGE', () => validateStore(snapshot, bytes));
    await check('PRODUCTION_SIGNATURE', () => {
      if (policy.releaseChannel !== 'production') return;
      const release = verifyRelease(stable, { publicKey: policy.updatePublicKey, installedSequence: policy.sequence,
        highestSeen: policy.sequence, allowCurrent: true, schema: { writerVersion: 3, minimumReader: 3 }, now });
      require(release.sequence === policy.sequence && release.version === policy.version
        && release.readerVersion === 3 && release.maximumSchema === 3
        && release.provenanceDigest === sha256(bytes('build-provenance.json')) && release.dependencyDigest === provenance.dependencyDigest);
      const artifact = snapshot.files.get(contract.artifactName);
      same(release.artifact, { name: contract.artifactName, bytes: artifact.bytes, sha256: artifact.sha256 });
    });
    await check('INPUT_STABILITY', async () => require(snapshotIdentity(snapshot)
      === snapshotIdentity(await artifactSnapshot(resolve(directory), { keep: false }))));
    report.status = 'PASSED'; report.sourceDigest = policy.sourceDigest;
    report.dependencyDigest = provenance.dependencyDigest; report.updaterEnabled = policy.releaseChannel === 'production';
  } catch (error) {
    active.status = 'FAILED'; report.failure = `${active.check}_REJECTED`;
    report.packageLeak = leakDiagnostic(error);
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failure = code => ({ ...reportBase(), failure: code });
  let result;
  if (process.argv.length !== 4) result = failure('USAGE_REQUIRES_OUTPUT_AND_PUBLIC_POLICY');
  else {
    // Public policy is an input, never inferred from the package or an installed
    // app. No artifact code, platform utility, network API or installer is run.
    const timer = setTimeout(() => { process.stdout.write(`${JSON.stringify(failure('VERIFICATION_TIMEOUT'))}\n`); process.exit(1); }, 120_000);
    try {
      const policy = artifactJSON(await readReleaseFile(resolve(process.argv[3])));
      result = await verifyDistribution(resolve(process.argv[2]), policy);
    } catch { result = failure('PUBLIC_POLICY_REJECTED'); }
    finally { clearTimeout(timer); }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.status === 'PASSED' ? 0 : 1;
}
