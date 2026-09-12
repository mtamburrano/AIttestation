import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { releasePreflight } from '../spikes/distribution/preflight.mjs';
import { dependencyInventory, fileInventory } from '../spikes/distribution/inventory.mjs';
import { localCommand, readOnlyCommand } from '../spikes/distribution/local.mjs';
import { validateHelperProfile } from '../spikes/distribution/release-inputs.mjs';
import { sha256 } from '../spikes/distribution/release.mjs';
import { canonical } from '../spikes/vault/format.mjs';

const privateMarker = 'PRIVATE-CREDENTIAL-EVIDENCE-TOKEN-VAULT-MARKER';
const repository = resolve(import.meta.dirname, '..');
const git = (root, args) => localCommand('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
  env: { GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid' } });

async function fixture(t) {
  const directory = await realpath(await mkdtemp('/private/tmp/provenance-preflight-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source'), goRoot = join(directory, 'go'), nodeRoot = join(directory, 'node');
  const moduleRoot = join(root, 'spikes/anchor/algorand');
  for (const path of [moduleRoot, join(root, 'spikes/distribution'), join(root, 'spikes/vault'), join(nodeRoot, 'bin'), join(directory, 'modules')]) {
    await mkdir(path, { recursive: true });
  }
  for (const name of ['preflight.mjs', 'release-inputs.mjs', 'local.mjs', 'config.mjs', 'release.mjs', 'inventory.mjs']) {
    await copyFile(join(repository, 'spikes/distribution', name), join(root, 'spikes/distribution', name));
  }
  await copyFile(join(repository, 'spikes/vault/format.mjs'), join(root, 'spikes/vault/format.mjs'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'spikes/distribution/THIRD_PARTY_NOTICES.md'), 'Synthetic test notices\n');
  await writeFile(join(moduleRoot, 'go.mod'), 'module synthetic-preflight-test\ngo 1.25.1\n');
  await writeFile(join(moduleRoot, 'go.sum'), '');
  await writeFile(join(moduleRoot, 'main.go'), 'package main\nfunc main() {}\n');
  await writeFile(join(root, '.gitignore'), 'ignored.go\n');
  git(root, ['init', '-q']); git(root, ['add', '.']); git(root, ['commit', '-q', '-m', 'Synthetic preflight baseline']);
  const goExecutable = join(goRoot, 'bin/go');
  const toolFiles = { 'bin/go': '#!/bin/sh\ncase "$1 $2" in\n"version ") printf "go version synthetic-test darwin/arm64\\n";;\n"env GOROOT") /usr/bin/dirname "$(/usr/bin/dirname "$0")";;\n*) exit 1;;\nesac\n',
    LICENSE: 'Synthetic Go license', PATENTS: 'Synthetic Go patents', VERSION: 'synthetic-test', 'go.env': 'Synthetic defaults',
    'src/runtime/runtime.go': 'package runtime\n', 'pkg/include/textflag.h': 'Synthetic header', 'lib/time/zoneinfo.zip': 'Synthetic lib data',
    ...Object.fromEntries(['compile', 'link', 'asm', 'cgo'].map(name => [`pkg/tool/darwin_arm64/${name}`, `Synthetic ${name}`])) };
  for (const [path, text] of Object.entries(toolFiles)) {
    await mkdir(resolve(goRoot, path, '..'), { recursive: true }); await writeFile(join(goRoot, path), text, { mode: 0o700 });
  }
  const node = join(nodeRoot, 'bin/node');
  await copyFile(process.execPath, node); await copyFile(resolve(process.execPath, '../../LICENSE'), join(nodeRoot, 'LICENSE'));
  const key = generateKeyPairSync('ed25519');
  const config = { sequence: 2, version: '1.2.0', releaseChannel: 'release-candidate', teamId: 'TESTTEAM01',
    signingIdentity: `Developer ID Application: ${privateMarker}`, notaryProfile: privateMarker,
    helperProvisioningProfile: join(directory, 'helper.provisionprofile'), updateOrigin: 'https://updates.example.invalid',
    updatePublicKey: key.publicKey.export({ format: 'jwk' }).x, updatePrivateKeyFile: join(directory, 'update-key.pem'),
    storeListingVerified: false, dependencyApprovalFile: join(directory, 'approval.json'), goExecutable, goModuleCache: join(directory, 'modules') };
  await writeFile(config.updatePrivateKeyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const configPath = join(directory, 'release-config.json');
  const saveConfig = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await saveConfig();
  const inventory = () => dependencyInventory(root, { goExecutable });
  const approve = async () => writeFile(config.dependencyApprovalFile, JSON.stringify({ inventoryDigest: sha256(canonical(await inventory())),
    reviewer: privateMarker, securityApproved: true, licensesApproved: true, expiresAt: new Date(Date.now() + 86400_000).toISOString() }), { mode: 0o600 });
  await approve();
  const certificateKey = join(directory, 'cms-key.pem'), certificate = join(directory, 'cms-cert.pem'), certificateConfig = join(directory, 'openssl.cnf');
  await writeFile(certificateConfig, '[req]\ndistinguished_name = dn\n[dn]\nCN = Synthetic-Preflight-Test\n');
  localCommand('/usr/bin/openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Synthetic-Preflight-Test',
    '-config', certificateConfig, '-days', '1', '-keyout', certificateKey, '-out', certificate]);
  const profile = { Entitlements: { 'com.apple.application-identifier': 'TESTTEAM01.ai.provenance.keychain-helper',
    'keychain-access-groups': ['TESTTEAM01.ai.provenance.evidence-vault'] }, TeamIdentifier: ['TESTTEAM01'],
    ExpirationDate: new Date(Date.now() + 86400_000).toISOString(), ProvisionsAllDevices: true };
  const saveProfile = async () => {
    let bytes = localCommand('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(profile) });
    if (Number.isFinite(Date.parse(profile.ExpirationDate))) {
      const date = new Date(profile.ExpirationDate).toISOString().replace(/\.\d{3}Z$/, 'Z');
      bytes = bytes.replace(`<string>${profile.ExpirationDate}</string>`, `<date>${date}</date>`);
    }
    localCommand('/usr/bin/openssl', ['smime', '-sign', '-binary', '-nodetach', '-outform', 'DER', '-signer', certificate,
      '-inkey', certificateKey, '-out', config.helperProvisioningProfile], { input: bytes });
  };
  await saveProfile();
  return { directory, root, moduleRoot, config, configPath, goRoot, nodeRoot, node, profile, saveProfile, saveConfig, approve,
    run: () => releasePreflight(root, configPath) };
}

function rejected(report, check) {
  assert.equal(report.status, 'FAILED'); assert.equal(report.failure, `${check}_REJECTED`);
  const index = report.checks.findIndex(item => item.check === check);
  assert.equal(report.checks[index].status, 'FAILED');
  assert.ok(report.checks.slice(index + 1).every(item => item.status === 'NOT_RUN'));
  assert.equal(report.sourceDigest, null); assert.equal(report.dependencyDigest, null);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 2048);
  assert.ok(!JSON.stringify(report).includes(privateMarker));
}

test('preflight shares production gates, is deterministic and leaves all synthetic inputs unchanged', async t => {
  const f = await fixture(t), before = await fileInventory(f.directory);
  const candidate = await f.run();
  assert.equal(candidate.status, 'PASSED', JSON.stringify(candidate));
  assert.equal(candidate.releaseChannel, 'release-candidate'); assert.equal(candidate.failure, null);
  assert.ok(candidate.checks.every(item => item.status === 'PASSED'));
  assert.deepEqual(await f.run(), candidate);
  assert.deepEqual(await fileInventory(f.directory), before);
  f.config.releaseChannel = 'production'; await f.saveConfig(); rejected(await f.run(), 'RELEASE_CONFIG');
  f.config.storeListingVerified = true; await f.saveConfig();
  assert.equal((await f.run()).status, 'PASSED');
  f.config.releaseChannel = privateMarker; await f.saveConfig(); rejected(await f.run(), 'RELEASE_CONFIG');
});

test('stale approval and wrong Node, Go or ignored input digests fail closed', async t => {
  const f = await fixture(t), approvalBytes = await readFile(f.config.dependencyApprovalFile);
  const approval = JSON.parse(approvalBytes); approval.expiresAt = '2000-01-01T00:00:00.000Z';
  await writeFile(f.config.dependencyApprovalFile, JSON.stringify(approval)); rejected(await f.run(), 'DEPENDENCY_APPROVAL');
  await writeFile(f.config.dependencyApprovalFile, approvalBytes);
  for (const path of [f.config.goExecutable, join(f.goRoot, 'pkg/tool/darwin_arm64/compile'), join(f.goRoot, 'src/runtime/runtime.go')]) {
    const original = await readFile(path); await writeFile(path, Buffer.concat([original, Buffer.from('\n# changed test input\n')]));
    rejected(await f.run(), 'DEPENDENCY_APPROVAL'); await writeFile(path, original);
  }
  const ignored = join(f.moduleRoot, 'ignored.go'); await writeFile(ignored, 'package main\n');
  rejected(await f.run(), 'DEPENDENCY_APPROVAL'); await rm(ignored);
  // Approval issued for another Node identity cannot authorize this executable.
  const otherInventory = await dependencyInventory(f.root, { goExecutable: f.config.goExecutable });
  otherInventory.node.sha256 = '0'.repeat(64);
  await writeFile(f.config.dependencyApprovalFile, JSON.stringify({ ...JSON.parse(approvalBytes), inventoryDigest: sha256(canonical(otherInventory)) }));
  const result = spawnSync(f.node, [join(f.root, 'spikes/distribution/preflight.mjs'), f.configPath],
    { env: {}, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr); rejected(JSON.parse(result.stdout), 'DEPENDENCY_APPROVAL');
  await writeFile(f.config.dependencyApprovalFile, approvalBytes);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    git(f.root, ['update-index', `--${flag}`, 'spikes/distribution/config.mjs']);
    rejected(await f.run(), 'CLEAN_SOURCE');
    git(f.root, ['update-index', `--no-${flag}`, 'spikes/distribution/config.mjs']);
  }
  const untracked = join(f.root, privateMarker); await writeFile(untracked, privateMarker);
  rejected(await f.run(), 'CLEAN_SOURCE'); await rm(untracked);
  await writeFile(join(f.moduleRoot, 'main.go'), 'package main\n// changed tracked input\n');
  rejected(await f.run(), 'CLEAN_SOURCE');
});

test('mismatched and malformed update keys never reach the profile check or output', async t => {
  const f = await fixture(t), keyBytes = await readFile(f.config.updatePrivateKeyFile);
  const other = generateKeyPairSync('ed25519');
  await writeFile(f.config.updatePrivateKeyFile, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  rejected(await f.run(), 'UPDATE_KEY');
  await writeFile(f.config.updatePrivateKeyFile, privateMarker); rejected(await f.run(), 'UPDATE_KEY');
  await writeFile(f.config.updatePrivateKeyFile, keyBytes); assert.equal((await f.run()).status, 'PASSED');
});

test('malformed, expired, wrong-team and non-distribution helper profiles fail closed', async t => {
  const f = await fixture(t), original = structuredClone(f.profile);
  for (const patch of [{ TeamIdentifier: 'TESTTEAM01' }, { TeamIdentifier: ['OTHERTEAM1'] }, { ExpirationDate: privateMarker },
    { ExpirationDate: '2000-01-01T00:00:00.000Z' }, { ProvisionsAllDevices: 'true' }, { ProvisionsAllDevices: false },
    { Entitlements: { ...original.Entitlements, 'keychain-access-groups': privateMarker } },
    { Entitlements: { ...original.Entitlements, 'com.apple.application-identifier': 'OTHERTEAM1.ai.provenance.keychain-helper' } }]) {
    Object.assign(f.profile, original, patch); await f.saveProfile(); rejected(await f.run(), 'HELPER_PROFILE');
    assert.throws(() => validateHelperProfile(f.profile, f.config));
  }
  await writeFile(f.config.helperProvisioningProfile, privateMarker); rejected(await f.run(), 'HELPER_PROFILE');
});

test('unsafe modes, links, special files and oversized config cannot be used as release inputs', async t => {
  const f = await fixture(t);
  for (const [path, unsafe, safe, check] of [[f.configPath, 0o644, 0o600, 'CONFIG_FILE'],
    [f.config.updatePrivateKeyFile, 0o644, 0o600, 'LOCAL_PERMISSIONS'], [f.config.dependencyApprovalFile, 0o666, 0o600, 'LOCAL_PERMISSIONS'],
    [f.config.helperProvisioningProfile, 0o666, 0o644, 'LOCAL_PERMISSIONS'], [f.config.goModuleCache, 0o777, 0o755, 'LOCAL_PERMISSIONS'],
    [f.config.goExecutable, 0o600, 0o700, 'LOCAL_PERMISSIONS']]) {
    await chmod(path, unsafe); rejected(await f.run(), check); await chmod(path, safe);
  }
  const path = f.config.updatePrivateKeyFile, saved = join(f.directory, 'saved-key');
  await rename(path, saved); await symlink(saved, path); rejected(await f.run(), 'LOCAL_PERMISSIONS'); await rm(path);
  await link(saved, path); rejected(await f.run(), 'LOCAL_PERMISSIONS'); await rm(path);
  localCommand('/usr/bin/mkfifo', [path]); rejected(await f.run(), 'LOCAL_PERMISSIONS'); await rm(path); await rename(saved, path);
  await chmod(f.directory, 0o777); rejected(await f.run(), 'CONFIG_FILE'); await chmod(f.directory, 0o700);
  await writeFile(f.configPath, privateMarker.repeat(2000)); rejected(await f.run(), 'CONFIG_FILE');
});

test('CLI emits only bounded JSON and ignores inherited credentials, Git helpers and network APIs', async t => {
  const f = await fixture(t), guard = join(f.directory, 'deny-network.mjs'), markerPath = join(f.directory, 'git-hook-ran');
  await writeFile(guard, `import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import dgram from 'node:dgram';
const deny = () => { throw Error('${privateMarker}'); };
globalThis.fetch = deny; net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
http.request = deny; http.get = deny; https.request = deny; https.get = deny; dns.lookup = deny; dns.resolve = deny;
dns.promises.lookup = deny; dns.promises.resolve = deny; dgram.createSocket = deny; syncBuiltinESMExports();\n`);
  const hook = join(f.directory, 'hostile-fsmonitor'); await writeFile(hook, `#!/bin/sh\necho ran > '${markerPath}'\n`, { mode: 0o700 });
  git(f.root, ['config', 'core.fsmonitor', hook]);
  const run = args => spawnSync(f.node, ['--import', guard, join(f.root, 'spikes/distribution/preflight.mjs'), ...args],
    { env: { APPLE_PASSWORD: privateMarker, ACCOUNT_TOKEN: privateMarker, VAULT_ID: privateMarker, UNRELATED: privateMarker,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: hook,
      HOME: f.directory, GOPROXY: 'https://never.example.invalid', GOSUMDB: 'never.example.invalid' },
      encoding: 'utf8', timeout: 30_000 });
  const success = run([f.configPath]); assert.equal(success.status, 0, success.stdout + success.stderr);
  const report = JSON.parse(success.stdout); assert.equal(report.status, 'PASSED'); assert.equal(success.stderr, '');
  assert.ok(success.stdout.length < 2048); assert.doesNotMatch(success.stdout, /PRIVATE|BEGIN|\/private\/|pem|https:|TESTTEAM/);
  assert.ok(!(await readdir(f.directory)).includes('git-hook-ran'));
  for (const args of [[], [join(f.directory, privateMarker)], [f.configPath, privateMarker]]) {
    const bad = run(args); assert.equal(bad.status, 1); assert.equal(bad.stderr, '');
    assert.equal(JSON.parse(bad.stdout).status, 'FAILED'); assert.ok(!bad.stdout.includes(privateMarker));
  }
  await writeFile(f.config.goExecutable, `#!/bin/sh\necho '${privateMarker}'\necho '${privateMarker}' >&2\nexit 7\n`);
  const noisy = run([f.configPath]); assert.equal(noisy.status, 1); assert.equal(noisy.stderr, '');
  rejected(JSON.parse(noisy.stdout), 'DEPENDENCY_INVENTORY'); assert.ok(!noisy.stdout.includes(privateMarker));
});

test('read-only subprocess sandbox denies filesystem mutation and sockets without contacting a service', async t => {
  const f = await fixture(t), forbidden = join(f.directory, 'must-not-exist');
  assert.throws(() => readOnlyCommand(f.node, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', forbidden]));
  assert.ok(!(await readdir(f.directory)).includes('must-not-exist'));
  // Socket creation/bind on an ephemeral loopback port exercises denial before
  // any DNS lookup or remote request can occur. No existing service is used.
  const output = readOnlyCommand(f.node, ['-e', `const server = require('node:net').createServer();
server.on('error', error => { if (error.code !== 'EPERM' && error.code !== 'EACCES') process.exit(2); });
server.listen(0, '127.0.0.1', () => { server.close(); process.exit(3); });`]);
  assert.equal(output, '');
});
