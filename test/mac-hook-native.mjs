// An explicit, fresh ad-hoc bundle exercises real kernel peer/signature checks.
// Its native fixture client is not a claim of Codex/Claude vendor integration.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, truncate } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

if (process.platform !== 'darwin' || ![3,4].includes(process.argv.length)
    || process.argv[3] && process.argv[3] !== '--large-client') throw Error('Usage: node test/mac-hook-native.mjs NEW_REPORT_FILE [--large-client]');
const reportPath = resolve(process.argv[2]);
const root = await mkdtemp('/private/tmp/attestamp-native-hook-test-'), repo = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'Native Test.app'), contents = join(app, 'Contents'), bin = join(contents, 'MacOS');
const support = join(root, 'support'), resources = join(contents, 'Resources');
const namespace = `test.attestamp.${randomUUID()}`, installationId = randomUUID();
const run = (exe, args) => execFileSync(exe, args, { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe', timeout: 60000 });
let host, hostFinished;
try {
  await mkdir(bin, { recursive: true }); await mkdir(resources); await mkdir(support, { mode: 0o700 });
  for (const name of ['coding', 'core', 'vault', 'recipient', 'diagnostics', 'anchor', 'platform', 'browser', 'distribution', 'managed']) {
    await cp(join(repo, 'spikes', name), join(resources, 'spikes', name), { recursive: true });
  }
  await cp(process.execPath, join(bin, 'node'));
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${namespace}.host</string><key>CFBundleExecutable</key><string>provenance-app-host</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const native = join(repo, 'spikes/coding/native'), shared = join(root, 'security.swift');
  await writeFile(shared, (await readFile(join(native, 'macos-hook-security.swift'), 'utf8')).replaceAll('ai.provenance.consumer', namespace));
  const receiver = join(root, 'receiver.swift');
  await writeFile(receiver, (await readFile(join(native, 'macos-hook-receiver.swift'), 'utf8'))
    .replace('String(cString: home) + "/Library/Application Support/Private Provenance"', JSON.stringify(support)));
  for (const [source, target] of [[receiver, 'provenance-hook-receiver'], [join(native, 'macos-hook-peer.swift'), 'provenance-hook-peer-validator']]) {
    run('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', join(root, 'swift-cache'), '-framework', 'Security', shared, source, '-o', join(bin, target)]);
  }
  const client = join(root, 'enrolled-fixture-client'), launcher = join(bin, 'provenance-hook-receiver');
  await writeFile(join(root, 'client.c'), `#include <unistd.h>\n#include <sys/wait.h>\n#include <time.h>\n#include <stdio.h>\nint main(void){struct timespec start,end;clock_gettime(CLOCK_MONOTONIC,&start);pid_t p=fork();if(p==0){char *a[]={${JSON.stringify(launcher)},"codex",${JSON.stringify(installationId)},0};execv(a[0],a);_exit(1);}int s;waitpid(p,&s,0);clock_gettime(CLOCK_MONOTONIC,&end);dprintf(4,"%f",(end.tv_sec-start.tv_sec)*1000.0+(end.tv_nsec-start.tv_nsec)/1000000.0);return WIFEXITED(s)?WEXITSTATUS(s):1;}\n`);
  const clientLinker = [];
  if (process.argv[3]) {
    const padding = join(root, 'synthetic-padding'); await writeFile(padding, ''); await truncate(padding, 202 * 1024 * 1024);
    clientLinker.push('-Wl,-sectcreate,__DATA,__fixture,' + padding);
  }
  run('/usr/bin/xcrun', ['clang', join(root, 'client.c'), ...clientLinker, '-o', client]);
  const codeHash = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', client], { encoding: 'utf8' }).stderr.match(/^CDHash=([a-f0-9]+)$/m)[1];
  const digest = createHash('sha256').update(await readFile(client)).digest('hex');
  const main = join(resources, 'native-test-runtime.mjs');
  await writeFile(main, `
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Vault } from './spikes/vault/vault.mjs';
import { SourceRegistry } from './spikes/core/source-registry.mjs';
import { startRecordingCore } from './spikes/core/runtime.mjs';
import { ENGINE_COMMAND_PROFILE, RECORDING_CONTROL_PROFILE } from './spikes/core/recording-engine.mjs';
import { EngineStateStore, lockResidentEngine } from './spikes/browser/chatgpt/engine-store.mjs';
import { startCodingRuntime } from './spikes/coding/runtime.mjs';
import { attestHookPeer } from './spikes/platform/macos/hook-peer.mjs';
import { CodingAdmission } from './spikes/coding/admission.mjs';
const directory=${JSON.stringify(support)}, epoch=randomUUID(), key=randomBytes(32), sources=new SourceRegistry();
const vault=new Vault(join(directory,'vault'),key,undefined,{create:true});
const core=await startRecordingCore({directory,sources,runtimeEpoch:epoch,vault,managed:null,fastTrust:{profile:'pap-algorand-fast-confirmation/1'},
 integrations:[{id:'codex',supported:true,previouslyEnabled:true}],platform:{lock:lockResidentEngine,stateStore:(p,v)=>new EngineStateStore(p,v)}});
const enrollment={client:'codex',installationId:${JSON.stringify(installationId)},operationId:'native-fixture',executable:{path:${JSON.stringify(client)},sha256:${JSON.stringify(digest)},codeHash:${JSON.stringify(codeHash)}}};
const counters={peer:0,authorized:0,admitted:0,rejected:0,released:0,save:0};
const admit=core.engine.admit.bind(core.engine);core.engine.admit=(...args)=>{try{const result=admit(...args);counters.admitted++;return result;}catch(error){counters.rejected++;throw error;}};
const release=core.engine.releaseAdmission.bind(core.engine);core.engine.releaseAdmission=(...args)=>{const result=release(...args);if(result)counters.released++;return result;};
const save=core.session.observe.bind(core.session);core.session.observe=(...args)=>{try{const result=save(...args);counters.save++;return result;}catch(error){counters.saveError=error.message;throw error;}};
const server=await startCodingRuntime({directory,engine:core.engine,sources,runtimeEpoch:epoch,
 integrations:{enrollment:(client,id)=>client==='codex'&&id===enrollment.installationId?enrollment:null},attestPeer:async(...args)=>{counters.peer++;const result=await attestHookPeer(...args);counters.authorized++;return result;}});
const extra=sources.attach({integrationId:'codex',installationId:randomUUID(),boundary:new CodingAdmission({integrationId:'codex',installationId:randomUUID(),runtimeEpoch:epoch,origin:'enrolled-local-executable'})});
console.log(JSON.stringify({ready:true}));
for await (const line of createInterface({input:process.stdin})) {
 const {kind}=JSON.parse(line);
 if(kind==='stop'){await server.close();await core.close();vault.close();break;}
 if(kind==='on'||kind==='off'||kind==='busy') {
  const state=core.engine.state();await core.engine.command({profile:ENGINE_COMMAND_PROFILE,controlProfile:RECORDING_CONTROL_PROFILE,runtimeEpoch:epoch,
   expectedRevision:state.revision,commandId:randomUUID(),kind:'SET_RECORDING',enabled:kind!=='off'},{surface:'desktop'});
  if(kind==='busy') for(let n=0;n<8;n++) core.engine.admit({text:'Synthetic queue pressure',sessionId:'busy-'+Math.floor(n/4),promptId:null,turnId:'t',invocationId:randomUUID(),scope:randomUUID()},extra,{deadline:performance.now()+100,authority:core.engine.beginAdmission()});
 }
 if(kind==='unavailable') await server.close();
 await core.engine.drain();console.log(JSON.stringify({count:core.session.versionCount,counters}));
}
`);
  const fastProfile = (await import('../spikes/anchor/algorand/fast-confirm.mjs')).FAST_CONFIRM_PROFILE;
  await writeFile(main, (await readFile(main, 'utf8')).replace('pap-algorand-fast-confirmation/1', fastProfile));
  const hostSource = join(root, 'host.c');
  await writeFile(hostSource, `#include <unistd.h>\n#include <sys/wait.h>\nint main(void){pid_t p=fork();if(p==0){char *a[]={${JSON.stringify(join(bin, 'node'))},${JSON.stringify(main)},0};execv(a[0],a);_exit(1);}int s;waitpid(p,&s,0);return WIFEXITED(s)?WEXITSTATUS(s):1;}\n`);
  run('/usr/bin/xcrun', ['clang', hostSource, '-o', join(bin, 'provenance-app-host')]);
  for (const [file, id] of [['node', 'runtime'], ['provenance-hook-receiver', 'hook-receiver'], ['provenance-hook-peer-validator', 'hook-peer-validator']]) {
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', `${namespace}.${id}`, join(bin, file)]);
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]); run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  assert.deepEqual(JSON.parse(run(join(bin, 'provenance-hook-peer-validator'), ['--identity', client])), { codeHash, profile: 'pap-coding-code-identity/1' });
  host = spawn(join(bin, 'provenance-app-host'), [], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  hostFinished = new Promise(resolve => host.once('close', resolve));
  const replies = [], waiters = [];
  let errors = ''; host.stderr.on('data', b => { errors += b.toString(); });
  createInterface({ input: host.stdout }).on('line', line => { const value = JSON.parse(line); waiters.length ? waiters.shift()(value) : replies.push(value); });
  const next = () => replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('NATIVE_RUNTIME_TIMEOUT: ' + errors)), 5000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal((await next()).ready, true);
  const command = async kind => { host.stdin.write(JSON.stringify({ kind }) + '\n'); return next(); };
  const report = { platform: process.platform, arch: process.arch, node: process.version,
    clientSize: (await readFile(client)).length,
    identity: 'REAL_KERNEL_PEERS_AND_AD_HOC_TEST_SIGNATURES', vendorClient: 'SYNTHETIC_ENROLLED_NATIVE_FIXTURE', samples: 60, paths: {} };
  for (const mode of ['off', 'on', 'busy', 'changed-client', 'unavailable']) {
    if (mode === 'changed-client') run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', namespace + '.changed', client]);
    const beforeState = await command(mode), before = beforeState.count, times = [], totalTimes = [];
    for (let i = 0; i < report.samples; i++) {
      const start = performance.now();
      const child = spawn(client, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] }); let stdout = '', stderr = '', measurement = '';
      child.stdio[4].on('data', b => { measurement += b.toString(); });
      child.stdout.on('data', b => { stdout += b.toString(); }); child.stderr.on('data', b => { stderr += b.toString(); });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'native-fixture', turn_id: 'turn', prompt: '\ufeffSynthetic native exact e\u0301\r\n\0' }));
      const result = await done; totalTimes.push(performance.now() - start);
      assert.ok(Number.isFinite(Number(measurement)) && Number(measurement) > 0); times.push(Number(measurement));
      assert.deepEqual(result, { code: 0, signal: null }); assert.equal(stdout, ''); assert.equal(stderr, '');
      await new Promise(resolve => setTimeout(resolve, 20));
      await command('drain');
    }
    const state = await command('drain'), after = state.count, ordered = [...times].sort((a,b) => a-b), p = n => ordered[Math.ceil(n*ordered.length)-1];
    report.paths[mode] = { p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maximumMs: p(1), saved: after-before, clientLaunchMaximumMs: Math.max(...totalTimes), counters: state.counters, over250Ms: times.filter(ms=>ms>250).length };
    if (mode === 'changed-client') assert.equal(state.counters.authorized, beforeState.counters.authorized, 'A re-signed client must require new enrollment');
    assert.equal(after-before, mode === 'on' ? report.samples : 0, JSON.stringify(report));
  }
  host.stdin.end('{"kind":"stop"}\n');
  await Promise.race([hostFinished, new Promise((_, reject) => setTimeout(() => reject(Error('NATIVE_RUNTIME_STOP_TIMEOUT')), 3000))]);
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  if (host && host.exitCode === null) { process.kill(-host.pid, 'SIGKILL'); await hostFinished; }
  await rm(root, { recursive: true, force: true });
}
