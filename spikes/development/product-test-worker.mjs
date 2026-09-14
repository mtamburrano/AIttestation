import { mkdtemp, rm, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalDiagnostics } from '../release/diagnostics.mjs';
import { initializeSponsor } from './sponsor.mjs';
import { newDirectory, initializeAccount, validateAccount } from './environment.mjs';
import { PRODUCT_SCENARIOS, productFixture, invariant } from './product-fixtures.mjs';
import { restrictFixtureNetwork } from './fixture-network.mjs';

const profile = 'pap-product-test/1';
const safeFailures = new Set(['SCENARIO_ASSERTION_FAILED', 'SCENARIO_TIMEOUT', 'EVIDENCE_PLAINTEXT_FOUND',
  'DIAGNOSTIC_LEAK_FOUND', 'FIXTURE_NETWORK_FORBIDDEN', 'FIXTURE_BRIDGE_FAILED']);
function options(args) {
  const result = { scenario: null, output: null, detailed: false, list: false }, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    invariant(!seen.has(arg), 'INVALID_RUNNER_OPTIONS'); seen.add(arg);
    if (arg === '--trace-synthetic') result.detailed = true;
    else if (arg === '--list') result.list = true;
    else if (arg === '--scenario') { result.scenario = args[++index]; invariant(PRODUCT_SCENARIOS.includes(result.scenario), 'UNKNOWN_SCENARIO'); }
    else if (arg === '--output') { result.output = args[++index]; invariant(typeof result.output === 'string', 'INVALID_RUNNER_OPTIONS'); }
    else invariant(false, 'INVALID_RUNNER_OPTIONS');
  }
  return result;
}
function html(report) {
  const escaped = JSON.stringify(report, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Attestamp local fixture report</title><style>body{max-width:960px;margin:3rem auto;padding:0 1rem;font:16px system-ui;color:#24312c;background:#f5f7f4}pre{padding:1rem;background:white;border:1px solid #ccd7cf;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#1c6241}</style>
<h1>Local product fixture report</h1><p>Synthetic provider, sponsor, confirmation and platform identity. Real engine, encrypted vault, local product API and native framing. This does not establish live browser, provider, platform or anchor assurance.</p>
<p>Review the exact bounded report below. The <a href="diagnostics.json" download>diagnostic export</a> contains the previewed events. Nothing is uploaded. Only reports remain after this run; delete this report directory when no longer needed.</p><pre>${escaped}</pre></html>`;
}

let root;
try {
  const selected = options(process.argv.slice(2));
  if (selected.list) {
    process.stdout.write(`${JSON.stringify({ profile, mode: 'SYNTHETIC_FIXTURE', scenarios: PRODUCT_SCENARIOS })}\n`);
  } else {
    if (selected.output) { await newDirectory(selected.output); root = selected.output; }
    else root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'attestamp-product-test-')));
    const diagnostics = new LocalDiagnostics({ mode: 'SYNTHETIC_FIXTURE', detailed: selected.detailed });
    const report = { profile, mode: 'SYNTHETIC_FIXTURE', status: 'PASS',
      dependencies: { provider: 'SYNTHETIC_NATIVE_PEER', sponsor: 'IN_PROCESS_FIXTURE',
        confirmation: 'SYNTHETIC_OBSERVATIONS_AND_VERDICT', platformIdentity: 'INJECTED_FIXTURE',
        custody: 'MEMORY_KEYS_ENCRYPTED_VAULT', network: 'EXPLICIT_LOCAL_PRODUCT_API_ONLY' },
      liveEvidence: 'NOT_TESTED', detailed: selected.detailed, selfChecks: [], scenarios: [] };
    const work = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'attestamp-fixtures-')));
    const network = restrictFixtureNetwork(work);
    let stage = 'PRIVATE_SETUP_FAILED';
    try {
      const paths = { control: join(work, 'control'), support: join(work, 'support'), chrome: join(work, 'chrome') };
      await initializeAccount(paths); await validateAccount(paths);
      // The umask is changed only in this isolated worker process.
      const previous = process.umask(0);
      try { await initializeSponsor(join(work, 'sponsor'), 37461); }
      finally { process.umask(previous); }
      report.selfChecks = ['FRESH_PRIVATE_ACCOUNT', 'FRESH_SPONSOR_OWNER_ONLY', 'TLS_KEY_MATCH', 'NO_EXTERNAL_SETUP_CALLS'];
      stage = 'PRODUCT_START_FAILED';
      for (const scenario of selected.scenario ? [selected.scenario] : PRODUCT_SCENARIOS) {
        const directory = join(work, `s${report.scenarios.length}`); await mkdir(directory, { mode: 0o700 });
        const started = performance.now();
        try {
          report.scenarios.push({ ...await productFixture(directory, scenario, diagnostics, network), durationMs: Math.round(performance.now() - started) });
        } catch (error) {
          report.status = 'FAIL';
          report.scenarios.push({ scenario, status: 'FAIL', reason: safeFailures.has(error?.code) ? error.code
            : ['EPERM', 'EACCES'].includes(error?.code) ? 'LOCAL_IPC_PERMISSION_DENIED' : stage,
            durationMs: Math.min(60_000, Math.round(performance.now() - started)) });
        }
      }
    } catch {
      report.status = 'FAIL'; report.reason = stage;
    } finally {
      network.restore();
      // Cleanup is confined to this invocation's newly created fixture subtree.
      try { await rm(work, { recursive: true, force: true }); }
      catch { report.status = 'FAIL'; report.reason = 'FIXTURE_CLEANUP_FAILED'; }
    }
    const preview = diagnostics.preview();
    report.diagnostics = preview.report;
    invariant(Buffer.byteLength(JSON.stringify(report)) < 320 * 1024);
    const page = html(report); invariant(Buffer.byteLength(page) < 512 * 1024);
    await writeFile(join(root, 'diagnostics.json'), diagnostics.export(preview.previewId), { flag: 'wx', mode: 0o600 });
    await writeFile(join(root, 'result.json'), JSON.stringify(report), { flag: 'wx', mode: 0o600 });
    await writeFile(join(root, 'report.html'), page, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ profile, mode: report.mode, status: report.status,
      scenarios: report.scenarios.map(({ scenario, status, observed, reason }) => ({ scenario, status, observed, reason })),
      reportDirectory: root })}\n`);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
} catch {
  process.stdout.write(`${JSON.stringify({ profile, mode: 'SYNTHETIC_FIXTURE', status: 'FAIL',
    reason: root ? 'REPORT_WRITE_FAILED' : 'INVALID_OPTIONS_OR_OUTPUT' })}\n`);
  process.exitCode = 2;
}
