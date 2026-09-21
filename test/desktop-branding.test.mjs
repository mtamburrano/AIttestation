import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseArtifactContract } from '../spikes/distribution/build-macos.mjs';
import { validateRelease } from '../spikes/distribution/release.mjs';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const legacyBrand = /private[ -]?provenance/i;

// Frozen before the display-name change. Keep this baseline independent of the
// production constants: a coordinated rename of both ends must still fail.
const baseline = JSON.parse(await read('test/fixtures/desktop-identities.json'));
const identityTokens = source => source.match(/\b(?:ai\.provenance[a-z0-9._-]*|pap-[a-z0-9-]+(?:\/\d+)?|PAP_[A-Z0-9_]+|PAP\/[A-Za-z0-9_/-]+(?:\\0)?|medilhopfckldjgdnchfkpmfmfnkadca)\b/g)?.sort();

test('consumer branding preserves bundle, Keychain, schema, protocol and extension identities', async () => {
  const sources = {};
  async function scan(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && !['bin', 'testdata', 'fixtures'].includes(entry.name)) await scan(file);
      else if (entry.isFile() && /\.(?:mjs|js|swift|go|plist)$/.test(file) && !file.endsWith('_test.go')) {
        const tokens = identityTokens(await read(file));
        if (tokens) sources[file] = tokens;
      }
    }
  }
  await scan('spikes');
  // Bundle/Keychain identities and cryptographic domain separators stay fixed.
  // Recording wire versions are deliberately migrated in the boundary tests.
  const retired = new Set(['spikes/demonstrator/build-macos.mjs', 'spikes/demonstrator/live-validation.mjs',
    'spikes/demonstrator/session.mjs', 'spikes/demonstrator/store.mjs', 'spikes/release/runtime.mjs',
    'spikes/release/fixture.mjs', 'spikes/release/composer.js', 'spikes/browser/chatgpt/product-app.js']);
  const stable = tokens => (tokens ?? []).filter(token => token.startsWith('ai.provenance')
    || token.startsWith('PAP/') || token === 'medilhopfckldjgdnchfkpmfmfnkadca').sort();
  for (const [file, tokens] of Object.entries(baseline.sources)) {
    if (retired.has(file) || !stable(tokens).length) continue;
    const current = file === 'spikes/demonstrator/verification.mjs' ? 'spikes/recipient/legacy-demo.mjs' : file;
    const observed = file === 'spikes/distribution/build-macos.mjs'
      ? [...(sources[file] ?? []), ...(sources['spikes/distribution/release-inputs.mjs'] ?? [])] : sources[current];
    assert.deepEqual(stable(observed), stable(tokens), `${file}: stable identity or crypto domain changed`);
  }
  for (const [file, expected] of Object.entries(baseline.json)) {
    const actual = JSON.parse(await read(file));
    if (file === 'spikes/browser/chatgpt/extension/manifest.json') {
      for (const key of ['name', 'short_name', 'description']) delete actual[key];
    }
    const migrated = structuredClone(expected);
    if (file === 'spikes/browser/chatgpt/extension/manifest.json') {
      migrated.version = '2.3.0';
      migrated.content_scripts = [
        { matches: ['https://chatgpt.com/*'], js: ['content-script.js'], run_at: 'document_start', world: 'ISOLATED' },
        { matches: ['https://chatgpt.com/*'], js: ['fetch-observer.js'], run_at: 'document_start', world: 'MAIN' },
      ];
      migrated.permissions = ['nativeMessaging', 'sidePanel'];
      migrated.action = { default_title: 'Open Attestamp' };
      migrated.side_panel = { default_path: 'sidepanel.html' };
      migrated.content_security_policy = { extension_pages: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    }
    if (file === 'spikes/distribution/fixtures/compatibility.json') {
      for (const fixture of migrated.cases) if (fixture.adapterProfile === 'pap-chatgpt-chrome/2') fixture.adapterProfile = 'pap-chatgpt-chrome/9';
      migrated.providerContract = 'chatgpt-web-text/2026-09-21.1';
      migrated.cases.push({ name: 'extension without epoch-bound reconnect', appSequence: 2,
        adapterProfile: 'pap-chatgpt-chrome/2', chromeMajor: 153, supported: false });
      migrated.cases.push({ name: 'legacy extension contract 3', appSequence: 2,
        adapterProfile: 'pap-chatgpt-chrome/3', chromeMajor: 153, supported: false });
      migrated.cases.push({ name: 'extension without independent document scopes', appSequence: 2,
        adapterProfile: 'pap-chatgpt-chrome/4', chromeMajor: 153, supported: false });
      migrated.cases.push({ name: 'obsolete strict request extraction contract', appSequence: 2,
        adapterProfile: 'pap-chatgpt-chrome/8', chromeMajor: 153, supported: false });
      migrated.cases.push({ name: 'obsolete human-qualified transport contract', appSequence: 2,
        adapterProfile: 'pap-chatgpt-chrome/7', chromeMajor: 153, supported: false });
      migrated.cases.push({ name: 'obsolete DOM acquisition contract', appSequence: 2,
        adapterProfile: 'pap-chatgpt-chrome/6', chromeMajor: 153, supported: false });
    }
    assert.deepEqual(actual, migrated, `${file}: public key, trust roots and release/provider configuration are frozen`);
  }
  assert.equal(JSON.parse(await read('package.json')).name, 'private-provenance-spikes');
  for (const file of ['spikes/browser/chatgpt/native/macos-browser-host.swift',
    'spikes/browser/chatgpt/native/macos-peer-validator.swift']) {
    const source = await read(file);
    assert.equal(source.match(/^private let chromeIdentifier = "([^"]+)"$/m)?.[1], 'com.google.Chrome');
    assert.equal(source.match(/^private let chromeTeamIdentifier = "([^"]+)"$/m)?.[1], 'EQHXZ8M8AV');
  }
  assert.ok((await read('spikes/vault/native/keychain-helper.entitlements.plist'))
    .includes('<string>$(AppIdentifierPrefix)ai.provenance.evidence-vault</string>'));
  assert.ok((await read('spikes/vault/native/macos-keychain-helper.swift'))
    .includes('private let accessGroupSuffix = ".ai.provenance.evidence-vault"'));
});

test('desktop pages, app builders and consumer guidance use Attestamp', async () => {
  for (const [file, title] of [
    ['spikes/browser/chatgpt/dashboard.html', 'Attestamp · Your prompts'],
    ['spikes/recipient/recipient.html', 'Attestamp · Verify evidence'],
  ]) {
    const source = await read(file);
    assert.ok(source.includes(`<title>${title}</title>`), file);
    assert.doesNotMatch(source, legacyBrand, file);
  }
  for (const [file, name] of [
    ['spikes/browser/chatgpt/build-macos.mjs', 'Attestamp'],
    ['spikes/recipient/build-macos.mjs', 'Attestamp Verifier'],
  ]) {
    const source = await read(file);
    assert.ok(source.includes(`'${name}.app'`), file);
    assert.ok(source.includes(`<key>CFBundleName</key><string>${name}</string>`), file);
  }
  for (const file of ['spikes/browser/chatgpt/dashboard.js', 'spikes/recipient/recipient.js']) assert.doesNotMatch(await read(file), legacyBrand, file);
  for (const file of ['README.md', 'spikes/browser/chatgpt/README.md', 'spikes/distribution/INSTALL.md',
    'spikes/recipient/README.md']) {
    const source = await read(file);
    assert.match(source, /Attestamp/, file);
    assert.doesNotMatch(source, legacyBrand, file);
  }
  const builder = await read('spikes/distribution/build-macos.mjs');
  for (const name of ['Attestamp.app', 'Attestamp Verifier.app', 'Attestamp Keychain',
    'Attestamp Release Candidate', 'Attestamp Verifier Release Candidate',
    'ATTESTAMP RELEASE CANDIDATE — PRE-PUBLICATION REVIEW ONLY']) assert.ok(builder.includes(name), name);
  assert.ok(builder.includes("'-volname', isReleaseCandidate ? 'Attestamp Release Candidate' : 'Attestamp'"));
});

test('remaining legacy desktop names are only documented technical compatibility values', async () => {
  const exceptions = {
    'spikes/vault/native/macos-app-host.swift': [
      '.appendingPathComponent("Library/Application Support/Private Provenance", isDirectory: true)',
      'contents.appendingPathComponent("Helpers/Private Provenance Keychain.app/Contents/MacOS/provenance-keychain-helper")',
    ],
    'spikes/browser/chatgpt/runtime-main.mjs': [
      "const defaultSupportDirectory = join(homedir(), 'Library', 'Application Support', 'Private Provenance');",
    ],
    'spikes/browser/chatgpt/native-host.mjs': [
      "const defaultRendezvous = join(homedir(), 'Library', 'Application Support', 'Private Provenance', 'browser-bridge.json');",
    ],
    'spikes/browser/chatgpt/build-macos.mjs': ["description: 'Private Provenance fixed-purpose ChatGPT bridge'"],
    'spikes/distribution/lifecycle.mjs': ["description: 'Private Provenance fixed-purpose ChatGPT bridge'"],
    'spikes/distribution/updater.mjs': ["'User-Agent': 'PrivateProvenance-Updater/1'"],
    'spikes/distribution/build-macos.mjs': [
      "join(contents, 'Helpers/Private Provenance Keychain.app/Contents')",
    ],
    'spikes/distribution/release-inputs.mjs': ['`Private-Provenance-${config.version}-${config.sequence}.dmg`'],
    'spikes/distribution/release.mjs': ['`Private-Provenance-${release.version}-${release.sequence}.dmg`'],
  };
  for (const [file, retained] of Object.entries(exceptions)) {
    let source = await read(file);
    for (const value of retained) {
      assert.ok(source.includes(value), `${file}: retain ${value}`);
      source = source.replace(value, '');
    }
    assert.doesNotMatch(source, legacyBrand, `${file}: undocumented legacy consumer copy`);
  }
  assert.match(await read('spikes/browser/chatgpt/runtime-main.mjs'), /Close Attestamp, replace the app in Finder/);
  const documentation = await read('spikes/distribution/README.md');
  for (const identifier of ['Library/Application Support/Private Provenance', 'Helpers/Private Provenance Keychain.app',
    'Private Provenance fixed-purpose ChatGPT bridge', 'Private-Provenance-VERSION-SEQUENCE.dmg',
    'PrivateProvenance-Updater/1', 'private-provenance-notary', 'Private Provenance Test', 'private-provenance-spikes']) {
    assert.ok(documentation.includes(`\`${identifier}\``), `${identifier} must be documented as technical`);
  }
});

test('candidate filenames use Attestamp while the production signed-update naming contract stays frozen', () => {
  const config = { version: '1.2.0', sequence: 3 };
  const production = releaseArtifactContract({ ...config, releaseChannel: 'production' });
  const candidate = releaseArtifactContract({ ...config, releaseChannel: 'release-candidate' });
  assert.equal(production.artifactName, 'Private-Provenance-1.2.0-3.dmg');
  assert.equal(candidate.artifactName, 'Attestamp-Release-Candidate-1.2.0-3.dmg');
  assert.equal(candidate.stableManifest, null);
  assert.equal(candidate.bundledInstalledRelease, null);
  assert.equal(candidate.updaterAvailable, false);
  const release = { profile: 'pap-desktop-release/1', ...config, platform: 'darwin-arm64',
    publishedAt: '2026-09-12T00:00:00.000Z', expiresAt: '2026-09-13T00:00:00.000Z', readerVersion: 3, maximumSchema: 3,
    artifact: { name: production.artifactName, bytes: 1, sha256: '1'.repeat(64) },
    provenanceDigest: '2'.repeat(64), dependencyDigest: '3'.repeat(64) };
  assert.deepEqual(validateRelease(release), release);
  for (const name of ['Attestamp-1.2.0-3.dmg', candidate.artifactName]) {
    assert.throws(() => validateRelease({ ...release, artifact: { ...release.artifact, name } }), /INVALID_RELEASE/);
  }
});
