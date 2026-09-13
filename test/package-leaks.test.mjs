import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertNoPackagedLeaks, artifactSnapshot, storeArchive } from '../spikes/distribution/artifact-files.mjs';
import { leakDiagnostic, PackageLeakError, rejectSecretBytes, rejectSecretName } from '../spikes/distribution/package-leaks.mjs';
import { readOnlyCommand } from '../spikes/distribution/local.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { fixture, resources, verifier, zip } from './artifact-policy-fixture.mjs';

const marker = 'DO-NOT-PRINT-PRIVATE-TEST-DATA';
const sentinel = `ATTESTAMP_SYNTHETIC_EVIDENCE_V1:${marker}`;
const cli = new URL('../spikes/distribution/verify-artifacts.mjs', import.meta.url).pathname;
const privateKey = generateKeyPairSync('ed25519').privateKey;
const forbidden = [
  ['PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' })],
  ['PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'der' })],
  ['PRIVATE_KEY', JSON.stringify({ nested: privateKey.export({ format: 'jwk' }) })],
  ['PRIVATE_APPROVAL', JSON.stringify({ inventoryDigest: 'a'.repeat(64), reviewer: marker, licensesApproved: true })],
  ['PRIVATE_RELEASE_CONFIG', JSON.stringify({ nested: { updatePrivateKeyFile: `/private/test/${marker}` } })],
  ['PRIVATE_RELEASE_CONFIG', JSON.stringify({ dependencyApprovalFile: `/private/test/${marker}` })],
  ['PRIVATE_RELEASE_CONFIG', JSON.stringify({ notaryProfile: marker })],
  ['LOCAL_SECRET_PATH', `/Users/${marker}/.ssh/id_ed25519`],
  ['LOCAL_SECRET_PATH', `/home/${marker}/.aws/credentials`],
  ['LOCAL_SECRET_PATH', `C:\\Users\\${marker}\\.aws\\credentials`],
  ['LOCAL_SECRET_PATH', `/Users/${marker}/Library/Keychains/login.keychain-db`],
  ['CREDENTIAL', JSON.stringify({ access_token: marker })],
  ['CREDENTIAL', `export AWS_SECRET_ACCESS_KEY=${marker}\n`],
  ['CREDENTIAL', `API_KEY="${marker}"\n`],
  ['CREDENTIAL', `const options = { "client_secret": "${marker}" };`],
  ['CREDENTIAL', `const apiKey = "${marker}";`],
  ['CREDENTIAL', `Authorization: Bearer ${marker}\n`],
  ['CREDENTIAL', `https://test-user:${marker}@service.example.invalid`],
  ['SYNTHETIC_EVIDENCE', sentinel],
];
const isLeak = category => error => error instanceof PackageLeakError && error.category === category;

async function isolated(t) {
  const directory = await realpath(await mkdtemp('/private/tmp/provenance-package-leak-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('bounded content rules reject generated private keys, operator records, local paths, credentials and evidence markers', () => {
  for (const [category, bytes] of forbidden) assert.throws(() => rejectSecretBytes(Buffer.from(bytes)), isLeak(category));
  for (const [type, options, formats] of [
    ['rsa', { modulusLength: 2048 }, ['pkcs1', 'pkcs8']],
    ['ec', { namedCurve: 'prime256v1' }, ['sec1', 'pkcs8']],
  ]) {
    const { privateKey } = generateKeyPairSync(type, options);
    for (const format of formats) assert.throws(() => rejectSecretBytes(privateKey.export({ type: format, format: 'der' })), isLeak('PRIVATE_KEY'));
    assert.throws(() => rejectSecretBytes(privateKey.export({ type: 'pkcs8', format: 'pem',
      cipher: 'aes-256-cbc', passphrase: marker })), isLeak('PRIVATE_KEY'));
  }
  assert.throws(() => rejectSecretBytes(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\n' + Buffer.alloc(64, 7).toString('base64'))), isLeak('PRIVATE_KEY'));
  assert.throws(() => rejectSecretBytes(Buffer.from('-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: synthetic-test\n\n'
    + Buffer.alloc(64, 7).toString('base64'))), isLeak('PRIVATE_KEY'));
});

test('public JWKs, PEM/DER public keys, Store identifiers, receipts and shipped licenses remain allowed', async t => {
  const directory = await isolated(t), { publicKey } = generateKeyPairSync('ed25519');
  const manifest = await readFile(new URL('../spikes/browser/chatgpt/extension/manifest.json', import.meta.url));
  const publicFiles = [
    ['public.pem', publicKey.export({ format: 'pem', type: 'spki' })],
    ['public.der', publicKey.export({ format: 'der', type: 'spki' })],
    ['public.json', JSON.stringify({ updateKey: publicKey.export({ format: 'jwk' }), storeId: 'medilhopfckldjgdnchfkpmfmfnkadca',
      receipt: { contentDigest: 'b'.repeat(64), signature: 'c'.repeat(86), observation: 'CLIENT_OBSERVED',
        evidenceAvailable: false, publicProof: { transactionId: 'A'.repeat(52), round: 123 } }, api_key: null, password: '' })],
    ['manifest.json', manifest],
    ['release-config.example.json', await readFile(new URL('../spikes/distribution/release-config.example.json', import.meta.url))],
    ['THIRD_PARTY_NOTICES.md', await readFile(new URL('../spikes/distribution/THIRD_PARTY_NOTICES.md', import.meta.url))],
    ['Node-LICENSE.txt', await readFile(resolve(process.execPath, '../../LICENSE'))],
    ['scanner-source.mjs', await readFile(new URL('../spikes/distribution/package-leaks.mjs', import.meta.url))],
    ['runtime-literals.dat', '\n  password = getArrayBufferOrView(password);\n\t"password":"\0",\0\t"hostname":"\0'],
    ['guide.txt', 'Private keys and evidence plaintext must remain local. ATTESTAMP_SYNTHETIC_EVIDENCE_V1:<unique-test-marker>'],
  ];
  for (const [name, bytes] of publicFiles) {
    assert.doesNotThrow(() => rejectSecretName(name));
    assert.doesNotThrow(() => rejectSecretBytes(Buffer.from(bytes)));
    await writeFile(join(directory, name), bytes);
  }
  await writeFile(join(directory, 'public.zip'), zip(publicFiles, { compressed: true }));
  await assertNoPackagedLeaks(directory);
});

test('private filenames are rejected even when empty, while renamed public examples cannot exempt private content', async t => {
  for (const name of ['.env', '.env.local', '.ssh/id_rsa', '.netrc', '.npmrc', '.aws/credentials', 'release-config.json',
    'release_config.rc.json', 'operator-dependency-approval.json', 'release-approval.json', 'key.p12', 'key.p8']) {
    assert.throws(() => rejectSecretName(name), error => error instanceof PackageLeakError);
  }
  const directory = await isolated(t);
  await writeFile(join(directory, 'release-config.example.json'), JSON.stringify({ updatePrivateKeyFile: marker }));
  await assert.rejects(assertNoPackagedLeaks(directory), isLeak('PRIVATE_RELEASE_CONFIG'));
});

test('decoded JSON escapes and UTF-16 cannot conceal known material', () => {
  const escaped = JSON.stringify({ record: sentinel }).replaceAll('A', '\\u0041');
  assert.throws(() => rejectSecretBytes(Buffer.from(escaped)), isLeak('SYNTHETIC_EVIDENCE'));
  assert.throws(() => rejectSecretBytes(Buffer.from(`{"api_\\u006bey":"${marker}"}`)), isLeak('CREDENTIAL'));
  for (const [category, value] of [['SYNTHETIC_EVIDENCE', sentinel], ['PRIVATE_RELEASE_CONFIG', JSON.stringify({ updatePrivateKeyFile: marker })]]) {
    const le = Buffer.from(value, 'utf16le'), be = Buffer.from(le).swap16();
    for (const bytes of [le, be, Buffer.concat([Buffer.from([0xff, 0xfe]), le]), Buffer.concat([Buffer.from([0xfe, 0xff]), be])]) {
      assert.throws(() => rejectSecretBytes(bytes), isLeak(category));
    }
  }
});

const duplicateJSON = [
  String.raw`{"api_\u006bey":"${marker}","api_key":null}`,
  String.raw`{"api_\u006bey":"${marker}","api_\u006bey":""}`,
  String.raw`{"evidence":"\u0041TTESTAMP_SYNTHETIC_EVIDENCE_V1:${marker}","evidence":null}`,
  String.raw`{"nested":{"api_\u006bey":"${marker}"},"nested":null}`,
];
function jsonEncodings(text) {
  const utf8 = Buffer.from(text), le = Buffer.from(text, 'utf16le'), be = Buffer.from(le).swap16();
  return [utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]), le, be,
    Buffer.concat([Buffer.from([0xff, 0xfe]), le]), Buffer.concat([Buffer.from([0xfe, 0xff]), be])];
}

test('decoded duplicate JSON members reject directly and inside nested ZIPs across supported encodings', async t => {
  const directory = await isolated(t), path = join(directory, `${marker}.dat`);
  for (const payload of duplicateJSON) {
    for (const text of [payload, `{"items":[{"public":true},${payload}]}`]) {
      for (const bytes of jsonEncodings(text)) {
        await writeFile(path, bytes);
        await assert.rejects(assertNoPackagedLeaks(directory), error => {
          assert.deepEqual(leakDiagnostic(error), { category: 'AMBIGUOUS_JSON', entry: 1, archiveEntries: [] });
          assert.doesNotMatch(JSON.stringify(leakDiagnostic(error)), /DO-NOT-PRINT|ATTESTAMP_SYNTHETIC|\.dat/);
          return true;
        });
        const inner = zip([['public.json', '{"api_key":null}'], [`${marker}.json`, bytes]], { compressed: true, descriptor: true });
        await writeFile(path, zip([['nested.dat', inner]], { compressed: true }));
        await assert.rejects(assertNoPackagedLeaks(directory), error => {
          assert.deepEqual(leakDiagnostic(error), { category: 'AMBIGUOUS_JSON', entry: 1, archiveEntries: [1, 2] });
          return true;
        });
      }
    }
  }
});

test('duplicate detection preserves public escaped data and independent sibling member names', async t => {
  const directory = await isolated(t), path = join(directory, 'public.dat');
  const { publicKey } = generateKeyPairSync('ed25519');
  const text = JSON.stringify({ publicKeys: [publicKey.export({ format: 'jwk' }), publicKey.export({ format: 'jwk' })],
    records: [{ evidence: { round: 123 }, api_key: null }, { evidence: null, api_key: '' }],
    description: 'Quoted "public": [braces{}] and escaped backslash \\', password: '' })
    .replaceAll('"kty"', '"\\u006bty"').replaceAll('"evidence"', '"\\u0065vidence"');
  for (const bytes of jsonEncodings(text)) {
    await writeFile(path, bytes); await assertNoPackagedLeaks(directory);
    await writeFile(path, zip([['nested.dat', zip([['public.json', bytes]], { compressed: true })]], { compressed: true }));
    await assertNoPackagedLeaks(directory);
  }
  assert.doesNotThrow(() => rejectSecretBytes(Buffer.from(String.raw`{"value":"\\u0041 is a literal escape","api_\u006bey":null}`)));
});

test('JSON depth, string-token and value budgets still reject with safe fixed categories', () => {
  assert.doesNotThrow(() => rejectSecretBytes(Buffer.from('['.repeat(32) + 'null' + ']'.repeat(32))));
  for (const text of ['['.repeat(33) + 'null' + ']'.repeat(33),
    '[' + '"",'.repeat(1_000_000) + '""]', '[' + '0,'.repeat(1_000_000) + '0]']) {
    assert.throws(() => rejectSecretBytes(Buffer.from(text)), isLeak('CONTENT_LIMIT'));
  }
});

test('prepared app, verifier, output and Store gates reject nested escaped duplicates in every channel', async t => {
  for (const channel of ['development', 'release-candidate', 'production']) {
    for (const [path, bytes] of [
      [`${resources}/spikes/distribution/settings.json`, jsonEncodings(duplicateJSON[0])[2]],
      [`${verifier}/Contents/Resources/spikes/recipient/settings.json`, jsonEncodings(`{"items":[${duplicateJSON[2]}]}`)[5]],
      ['Start Here.md', jsonEncodings(duplicateJSON[2])[1]],
      ['Chrome-Web-Store-upload.zip', zip([['nested.dat', zip([['settings.json',
        jsonEncodings(`{"items":[${duplicateJSON[0]}]}`)[4]]], { compressed: true })]], { compressed: true })],
    ]) {
      const f = await fixture(t, channel), policy = structuredClone(f.policy);
      assert.equal((await f.run()).status, 'PASSED');
      await f.write(path, bytes); await f.seal();
      const report = await f.run(); assert.deepEqual(f.policy, policy);
      assert.equal(report.status, 'FAILED'); assert.equal(report.failure, 'OUTPUT_FILES_REJECTED');
      assert.equal(report.packageLeak.category, 'AMBIGUOUS_JSON');
      assert.ok(Number.isSafeInteger(report.packageLeak.entry));
      assert.deepEqual(report.packageLeak.archiveEntries, path.endsWith('.zip') ? [1, 1] : []);
      assert.equal(report.releaseReady, false); assert.equal(report.sourceDigest, null); assert.equal(report.dependencyDigest, null);
      assert.doesNotMatch(JSON.stringify(report), /DO-NOT-PRINT|ATTESTAMP_SYNTHETIC|\/private\/tmp|settings\.json/);
    }
  }
});

test('the complete large-file stream is scanned across chunk boundaries, both UTF-16 alignments and the metadata cap', async t => {
  const directory = await isolated(t); await mkdir(join(directory, 'Contents/MacOS'), { recursive: true });
  const path = join(directory, 'Contents/MacOS/test-binary');
  for (const [category, value, offset] of [
    ['SYNTHETIC_EVIDENCE', Buffer.from(sentinel), 1024 * 1024 - 12],
    ['SYNTHETIC_EVIDENCE', Buffer.from(sentinel, 'utf16le'), 1024 * 1024 - 11],
    ['SYNTHETIC_EVIDENCE', Buffer.from(sentinel, 'utf16le').swap16(), 17 * 1024 * 1024 - 21],
    ['PRIVATE_KEY', Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })), 17 * 1024 * 1024],
    ['CREDENTIAL', Buffer.from(`\nAPI_KEY=${marker}\n`), 17 * 1024 * 1024],
    ['PRIVATE_KEY', Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' }))), 17 * 1024 * 1024],
  ]) {
    const bytes = Buffer.alloc(17 * 1024 * 1024 + 1024, 0x78); value.copy(bytes, offset);
    await writeFile(path, bytes);
    await assert.rejects(artifactSnapshot(directory, { keep: false }), isLeak(category));
  }
  const oversizedZIP = Buffer.alloc(17 * 1024 * 1024); oversizedZIP.writeUInt32LE(0x04034b50);
  await writeFile(path, oversizedZIP);
  await assert.rejects(artifactSnapshot(directory, { keep: false }));
});

test('renamed and nested compressed ZIPs receive the same rules with aggregate expansion and nesting limits', async t => {
  const directory = await isolated(t), path = join(directory, 'renamed.dat');
  for (const [category, bytes] of forbidden) {
    const archive = zip([['public.txt', 'public proof'], [`${marker}.txt`, bytes]], { compressed: true, descriptor: true });
    await writeFile(path, zip([['nested.dat', archive]], { compressed: true }));
    await assert.rejects(assertNoPackagedLeaks(directory), error => {
      assert.deepEqual(leakDiagnostic(error), { category, entry: 1, archiveEntries: [1, 2] }); return true;
    });
  }
  assert.throws(() => storeArchive(zip([['oversized.txt', Buffer.alloc(16 * 1024 * 1024 + 1)]], { compressed: true })));
  let nested = zip([['ok.txt', 'public']]);
  for (let i = 0; i < 4; i++) nested = zip([['nested.zip', nested]], { compressed: true });
  assert.throws(() => storeArchive(nested));
  const crowded = zip(Array.from({ length: 256 }, (_, i) => [`${i}.txt`, 'public']));
  assert.throws(() => storeArchive(zip([['inner.zip', crowded]])));
});

test('development, RC and production policy gates reject app, verifier, output and Store leaks before acceptance', async t => {
  for (const channel of ['development', 'release-candidate', 'production']) {
    for (const path of [`${resources}/spikes/distribution/extra.txt`, `${verifier}/Contents/Resources/spikes/recipient/extra.txt`,
      'Start Here.md', 'Chrome-Web-Store-upload.zip']) {
      const f = await fixture(t, channel);
      assert.equal((await f.run()).status, 'PASSED');
      await f.write(path, path.endsWith('.zip') ? zip([[`${marker}.txt`, sentinel]], { compressed: true }) : sentinel);
      await f.seal();
      const report = await f.run();
      assert.equal(report.status, 'FAILED'); assert.equal(report.failure, 'OUTPUT_FILES_REJECTED');
      assert.equal(report.packageLeak.category, 'SYNTHETIC_EVIDENCE'); assert.equal(report.releaseReady, false);
      assert.equal(report.sourceDigest, null); assert.equal(report.dependencyDigest, null);
      assert.doesNotMatch(JSON.stringify(report), /DO-NOT-PRINT|ATTESTAMP_SYNTHETIC|\/private\/tmp/);
    }
  }
});

test('CLI leak reports are bounded and deterministic without filenames, evidence, keys, environment or raw errors', async t => {
  const f = await fixture(t), policy = join(f.directory, 'public-policy.json'); await writeFile(policy, canonical(f.policy));
  const invoke = () => spawnSync(process.execPath, [cli, f.output, policy], { env: {}, encoding: 'utf8', timeout: 15_000 });
  for (const [category, bytes] of [['SYNTHETIC_EVIDENCE', sentinel], ['AMBIGUOUS_JSON',
    zip([[`${marker}.json`, jsonEncodings(duplicateJSON[2])[5]]], { compressed: true })]]) {
    await f.write(`${resources}/${marker}.txt`, bytes);
    const first = invoke(), second = invoke();
    assert.equal(first.status, 1); assert.equal(first.stderr, ''); assert.equal(second.stdout, first.stdout);
    const report = JSON.parse(first.stdout); assert.equal(report.packageLeak.category, category);
    assert.ok(Number.isSafeInteger(report.packageLeak.entry)); assert.ok(first.stdout.length < 2048);
    assert.doesNotMatch(first.stdout, /DO-NOT-PRINT|ATTESTAMP_SYNTHETIC|\/private\/tmp|Error:|\.txt|\.json/);
  }
});

test('leak rejection still works with writes, network, Mach lookups and Apple Events denied', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), policy = join(f.directory, 'public-policy.json'); await writeFile(policy, canonical(f.policy));
  await f.write('Chrome-Web-Store-upload.zip', zip([['private.txt', sentinel]], { compressed: true }));
  const inspect = `import { verifyDistribution } from ${JSON.stringify(new URL('../spikes/distribution/verify-artifacts.mjs', import.meta.url).href)};
    const report = await verifyDistribution(process.argv[1], JSON.parse(process.argv[2]));
    if (report.packageLeak?.category !== 'SYNTHETIC_EVIDENCE') process.exit(2);
    console.log('REJECTED_SAFELY');`;
  assert.equal(readOnlyCommand(process.execPath, ['--input-type=module', '-e', inspect, f.output, canonical(f.policy)]).trim(), 'REJECTED_SAFELY');
});

test('packaging gates precede Apple submission and disk-image compression, and follow private-work cleanup', async () => {
  const source = await readFile(new URL('../spikes/distribution/build-macos.mjs', import.meta.url), 'utf8');
  assert.match(source, /await signBundle\([^;]+;\s*await assertNoPackagedLeaks\(bundle\);[\s\S]+?await notarize\(zip,/);
  assert.match(source, /await assertNoPackagedLeaks\(payload\);\s*run\('\/usr\/bin\/hdiutil'/);
  assert.match(source, /finally \{ await rm\(work, \{ recursive: true, force: true \}\); \}/);
  assert.match(source, /const result = await prepareDistribution\(output, config\);\s*\/\/[^\n]+\n\s*await assertNoPackagedLeaks\(output\);\s*return result;/);
});
