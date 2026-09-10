import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDemo } from './server.mjs';
import { inclusion, anchorPayload } from '../anchor/merkle.mjs';
import { canonical, unb64 } from '../vault/format.mjs';
import { verifyBundle } from './verification.mjs';

// Local integration harness only: it never reads a seed or submits a transaction.
// A separately authorized live driver supplies the one aggregate anchor archive.
if (process.argv.length !== 3) throw Error('Usage: node spikes/demonstrator/live-validation.mjs DEDICATED_TEST_DIRECTORY');
const root = resolve(process.argv[2]);
if (await realpath(root) !== root || (await stat(root)).mode & 0o077) throw Error('Owner-only canonical test directory required');
const account = JSON.parse(await readFile(join(root, 'account.json'), 'utf8'));
if (account.network !== 'testnet-v1.0' || account.maximumSelfPayments !== 1
    || account.purpose !== 'fresh synthetic integrated demonstrator test') throw Error('Dedicated test declaration required');
const checkpoint = JSON.parse(await readFile(join(root, 'trust.json'), 'utf8'));
const trust = { profile: checkpoint.profile, network: checkpoint.network, genesis: checkpoint.genesis, checkpoint };
const appDirectory = join(root, 'integrated-app'); await mkdir(appDirectory, { mode: 0o700 });
const app = await startDemo(appDirectory);
const save = (name, value) => writeFile(join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
try {
  app.session.enroll('live-synthetic-scope', 'algorand', trust);
  const versions = [], payloads = [];
  for (const mode of ['Continuous', 'Sealed', 'Always Protect']) {
    const payload = { text: `New synthetic ${mode} draft · exact e\u0301 bytes · ${new Date().toISOString()}`,
      attachments: [{ name: `synthetic-${versions.length + 1}.bin`, bytes: Buffer.from([0, 255, 13, 10, versions.length + 1]).toString('base64') }] };
    const v = await app.session.freeze({ mode, payload, scope: 'live-synthetic-scope', supported: true });
    versions.push(v); payloads.push(payload);
    assert.equal(v.state, 'PENDING_ANCHOR');
    if (mode === 'Continuous') await app.session.release({ id: v.id, scope: v.scope, currentPayload: payload, supported: true });
    else await assert.rejects(app.session.release({ id: v.id, scope: v.scope, currentPayload: payload, supported: true }), /confirmation/);
  }
  assert.equal(app.egress.size, 1);
  const digests = versions.map(v => unb64(v.recordDigest, 32));
  const batches = versions.map((v, i) => inclusion(digests, i));
  await save('anchor-payload.json', { payload: anchorPayload(unb64(batches[0].root, 32)).toString('base64') });
  await save('independent-trust.json', trust);
  await save('frozen-versions.json', versions);
  await save('pre-anchor-export.json', app.session.exportDisclosure());
  console.log('Prepared three new mode commitments in one 36-byte anchor payload. Continuous sent; protected versions remain pending.');
  const deadline = Date.now() + 40 * 60 * 1000; let archive;
  for (let poll = 0; Date.now() < deadline; poll++) {
    try { archive = JSON.parse(await readFile(join(root, 'archive.json'), 'utf8')); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (poll % 12 === 0) console.log('PENDING_ARCHIVE: no protected-byte release. Awaiting the authorized driver’s archive.');
    await delay(5000);
  }
  if (!archive) throw Error('Archive deadline reached; no protected versions released');
  const states = [];
  for (const [i, v] of versions.entries()) {
    const envelope = canonical({ profile: 'pap-anchor-envelope/1', recordDigest: v.recordDigest, batch: batches[i],
      adapter: { profile: trust.profile, network: trust.network, genesis: trust.genesis }, proof: archive });
    const before = app.egress.size;
    const confirmed = await app.session.confirm({ id: v.id, proof: envelope });
    assert.equal(confirmed.anchor, 'CONSENSUS_VERIFIED'); assert.equal(app.egress.size, before);
    if (v.mode !== 'Continuous') {
      assert.equal(confirmed.state, 'SEALED_NOT_SENT');
      await assert.rejects(app.session.release({ id: v.id, scope: v.scope, supported: true,
        currentPayload: { ...payloads[i], text: 'edited after confirmation' } }), /Stale/);
      await assert.rejects(app.session.release({ id: v.id, scope: 'unsupported-scope', supported: false,
        currentPayload: payloads[i] }), /UNSUPPORTED_PATH/);
      await app.session.release({ id: v.id, scope: v.scope, supported: true, currentPayload: payloads[i] });
    }
    assert.deepEqual([...app.egress.values()].find(a => a.sealId === v.id).payload, payloads[i]);
    states.push({ mode: v.mode, confirmedState: confirmed.state, anchor: confirmed.anchor, exactVersionRelease: true });
    await save(`envelope-${i + 1}.json`, envelope);
  }
  assert.equal(app.egress.size, 3);
  const { trust: ignored, ...bundle } = app.session.exportDisclosure();
  const report = verifyBundle(bundle, trust);
  assert.equal(report.valid, true); assert.equal(report.anchors.length, 3);
  assert.ok(report.anchors.every(a => a.anchor === 'CONSENSUS_VERIFIED' && a.timestamp === 'BLOCK_HASH_BOUND'));
  const recovery = app.session.exportRecovery();
  await save('encrypted-recovery.json', recovery.package); await save('separate-recovery-secret.txt', recovery.recoveryKey);
  const restored = app.session.restore(recovery.package, recovery.recoveryKey);
  assert.equal(restored.snapshot, 'COMPLETE'); assert.match(restored.releaseAuthority, /^NONE/);
  assert.equal(verifyBundle(restored.bundle, trust).valid, true);
  await save('evidence-export.json', bundle); await save('restored-evidence-export.json', restored.bundle);
  await save('live-integration-report.json', { source: 'DEDICATED_ALGORAND_TEST', transactionId: archive.transactionId,
    network: trust.network, states, verification: report, restore: { snapshot: restored.snapshot,
      latestState: restored.latestState, releaseAuthority: restored.releaseAuthority },
    visibleResponse: 'Not asserted by this API harness; DOM capture covered by the separate Chrome walkthrough',
    completedAt: new Date().toISOString() });
  console.log('PASS: one live aggregate commitment validates all three exact versions; protected release waits for independently verified proof; clean restore preserves verification.');
} finally { await app.close(); }
