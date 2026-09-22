import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm, chmod, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectSigningAccess, withSigningAccess, preflightSigning } from '../spikes/development/signing.mjs';
import { command } from '../spikes/development/cli.mjs';

async function isolated(t) {
  const root = await realpath(await mkdtemp('/private/tmp/attestamp-signing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signingKeychain = join(root, 'synthetic.keychain-db');
  await writeFile(signingKeychain, 'synthetic, never an actual Keychain', { mode: 0o600 });
  return { root, config: { signingIdentity: 'A'.repeat(40), signingKeychain } };
}

test('signing inspection accepts only a successful bounded authorization label', () => {
  const config = { signingIdentity: 'A'.repeat(40), signingKeychain: '/private/synthetic' };
  for (const label of ['KEYCHAIN_LOCKED', 'KEYCHAIN_UNAVAILABLE', 'IDENTITY_UNAVAILABLE',
    'CODESIGN_AUTHORIZATION_REQUIRED', 'PARTITION_AUTHORIZATION_REQUIRED']) {
    assert.deepEqual(inspectSigningAccess('/helper', config, () => { throw { stdout: `${label}\n` }; }),
      { status: 'OWNER_ACTION_REQUIRED', reason: label });
  }
  for (const stdout of ['AUTHORIZED', 'secret', 'KEYCHAIN_LOCKED\nsecret']) {
    assert.equal(inspectSigningAccess('/helper', config, () => { throw { stdout }; }).reason, 'PREFLIGHT_UNAVAILABLE');
  }
  assert.equal(inspectSigningAccess('/helper', config, () => { throw { code: 'ETIMEDOUT' }; }).reason, 'PREFLIGHT_TIMED_OUT');
});

test('preflight rejects missing selection and invalid CLI inputs without signing', async () => {
  assert.deepEqual(await preflightSigning({}), { status: 'OWNER_ACTION_REQUIRED', reason: 'KEYCHAIN_SELECTION_REQUIRED' });
  assert.deepEqual(await command(['signing-preflight', '/private/nonexistent-signing-config']),
    { status: 'OWNER_ACTION_REQUIRED', reason: 'SIGNING_INPUTS_INVALID' });
});

test('preflight gates all build work, pins the keychain and removes only its own probe', { skip: process.platform !== 'darwin' }, async t => {
  const { root, config } = await isolated(t);
  let calls = [], inspected = 'AUTHORIZED', built = 0, helperPath;
  const run = (tool, args) => {
    calls.push({ tool, args });
    if (tool.endsWith('signing-access')) { helperPath = tool; return inspected; }
    return '';
  };
  const operation = async inspect => { built++; return inspect(); };
  inspected = 'KEYCHAIN_LOCKED';
  assert.equal((await withSigningAccess(config, operation, run)).reason, 'KEYCHAIN_LOCKED');
  assert.equal(built, 0); assert.ok(!calls.some(call => call.tool === '/usr/bin/codesign'));
  inspected = 'AUTHORIZED'; calls = [];
  assert.deepEqual(await withSigningAccess(config, operation, run), { status: 'AUTHORIZED' });
  assert.equal(built, 1);
  const probe = calls.find(call => call.tool === '/usr/bin/codesign');
  assert.ok(probe.args.includes('--dryrun')); assert.ok(probe.args.includes('--timestamp=none'));
  assert.equal(probe.args[probe.args.indexOf('--keychain') + 1], config.signingKeychain);
  await assert.rejects(readFile(helperPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), ['synthetic.keychain-db']);
  for (const code of ['ETIMEDOUT', 'FAILURE']) {
    const result = await withSigningAccess(config, operation, (tool, args) => {
      if (tool === '/usr/bin/codesign') throw { code, stderr: 'secret' };
      return run(tool, args);
    });
    assert.equal(result.reason, code === 'ETIMEDOUT' ? 'SIGNING_PROBE_TIMED_OUT' : 'SIGNING_PROBE_FAILED');
    assert.equal(built, 1);
  }
  await chmod(config.signingKeychain, 0o644);
  assert.equal((await withSigningAccess(config, operation, run)).reason, 'KEYCHAIN_UNAVAILABLE');
  await chmod(config.signingKeychain, 0o600);
  const alias = join(root, 'alias'); await symlink(config.signingKeychain, alias);
  assert.equal((await withSigningAccess({ ...config, signingKeychain: alias }, operation, run)).reason, 'KEYCHAIN_UNAVAILABLE');
});

test('native ACL inspection handles scoped signing permission and partition restrictions without storage', {
  skip: process.platform !== 'darwin',
}, async t => {
  const { root } = await isolated(t), binary = join(root, 'acl-test');
  const options = { env: { PATH: '/usr/bin:/bin', TMPDIR: root }, encoding: 'utf8', timeout: 60000, maxBuffer: 65536 };
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wno-deprecated-declarations',
    '-framework', 'Foundation', '-framework', 'Security', 'test/fixtures/signing-access.m', '-o', binary], options);
  assert.equal(execFileSync(binary, [], { ...options, timeout: 15000 }).trim(), 'PASS');
});
