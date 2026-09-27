// An explicit, fresh ad-hoc bundle exercises real kernel peer/signature checks.
// Its native fixture client is not a claim of Codex/Claude vendor integration.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, truncate } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { cpus, loadavg, release } from 'node:os';

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
  // Timing is compiled into this disposable fixture only. No production flag,
  // environment switch, extra output or diagnostic disk write is introduced.
  let receiverSource = (await readFile(join(native, 'macos-hook-receiver.swift'), 'utf8'))
    .replace('String(cString: home) + "/Library/Application Support/Private Provenance"', JSON.stringify(support));
  const timing = `\nprivate func measure(_ stage: String) { var now = timespec(); clock_gettime(CLOCK_MONOTONIC, &now); let line = "\\(stage) \\(Double(now.tv_sec) * 1000 + Double(now.tv_nsec) / 1000000)\\n"; line.withCString { _ = write(5, $0, strlen($0)) } }\n`;
  receiverSource = receiverSource.replace('import Foundation', 'import Foundation' + timing)
    .replace('static func main() {', 'static func main() {\n    measure("main")')
    .replace('try hookValidateBundle()', 'try hookValidateBundle(); measure("bundle")')
    .replace('let resident = try hookPeer(connection)', 'measure("connected"); let resident = try hookPeer(connection)')
    .replace('var input = Data()', 'measure("resident"); var input = Data()')
    .replace('let admitted = try response', 'measure("sent"); let admitted = try response')
    .replace('try send(connection, ["profile": profile, "kind": "RELEASE"', 'measure("admitted"); try send(connection, ["profile": profile, "kind": "RELEASE"')
    .replace('== admitted else { throw HookFailure.rejected }', '== admitted else { throw HookFailure.rejected }; measure("released")');
  await writeFile(receiver, receiverSource);
  for (const [source, target] of [[receiver, 'provenance-hook-receiver'], [join(native, 'macos-hook-peer.swift'), 'provenance-hook-peer-validator']]) {
    run('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', join(root, 'swift-cache'), '-framework', 'Security', shared, source, '-o', join(bin, target)]);
  }
  const client = join(root, 'enrolled-fixture-client'), launcher = join(bin, 'provenance-hook-receiver');
  await writeFile(join(root, 'client.c'), `#include <unistd.h>\n#include <sys/wait.h>\n#include <time.h>\n#include <stdio.h>\nint main(void){struct timespec start,end;clock_gettime(CLOCK_MONOTONIC,&start);dprintf(5,"start %.6f\\n",start.tv_sec*1000.0+start.tv_nsec/1000000.0);pid_t p=fork();if(p==0){char *a[]={${JSON.stringify(launcher)},"codex",${JSON.stringify(installationId)},0};execv(a[0],a);_exit(1);}int s;waitpid(p,&s,0);clock_gettime(CLOCK_MONOTONIC,&end);dprintf(4,"%f",(end.tv_sec-start.tv_sec)*1000.0+(end.tv_nsec-start.tv_nsec)/1000000.0);return WIFEXITED(s)?WEXITSTATUS(s):1;}\n`);
  const clientLinker = [];
  if (process.argv[3]) {
    const padding = join(root, 'synthetic-padding'); await writeFile(padding, ''); await truncate(padding, 202 * 1024 * 1024);
    clientLinker.push('-Wl,-sectcreate,__DATA,__fixture,' + padding);
  }
  run('/usr/bin/xcrun', ['clang', join(root, 'client.c'), ...clientLinker, '-o', client]);
  const codeHash = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', client], { encoding: 'utf8' }).stderr.match(/^CDHash=([a-f0-9]+)$/m)[1];
  const identity = async path => ({ path, script: false, sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    codeHash: spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', path], { encoding: 'utf8' }).stderr.match(/^CDHash=([a-f0-9]+)$/m)[1] });
  const second = join(root, 'second-native-client'), last = join(root, 'fourth-native-client'), interpreter = join(root, 'script-interpreter');
  for (const [path, id] of [[second, 'second'], [last, 'fourth'], [interpreter, 'interpreter']]) {
    await cp(client, path); run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', namespace + '.' + id, path]);
  }
  const unenrolled = join(root, 'unenrolled-copy'); await cp(second, unenrolled);
  const script = join(root, 'script-client'); await writeFile(script, '#!synthetic-fixture\n', { mode: 0o700 });
  const executables = [await identity(client), await identity(second), { path: script, script: true,
    sha256: createHash('sha256').update(await readFile(script)).digest('hex'), interpreter: await identity(interpreter) }, await identity(last)];
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
const enrollment={client:'codex',installationId:${JSON.stringify(installationId)},operationId:'native-fixture',executables:${JSON.stringify(executables)}};
const counters={peer:0,authorized:0,admitted:0,rejected:0,released:0,save:0}, timings={peer:[],admission:[]};
const admit=core.engine.admit.bind(core.engine);core.engine.admit=(...args)=>{const start=performance.now();try{const result=admit(...args);counters.admitted++;return result;}catch(error){counters.rejected++;throw error;}finally{timings.admission.push(performance.now()-start);}};
const release=core.engine.releaseAdmission.bind(core.engine);core.engine.releaseAdmission=(...args)=>{const result=release(...args);if(result)counters.released++;return result;};
const save=core.session.observe.bind(core.session);core.session.observe=(...args)=>{try{const result=save(...args);counters.save++;return result;}catch(error){counters.saveError=error.message;throw error;}};
const server=await startCodingRuntime({directory,engine:core.engine,sources,runtimeEpoch:epoch,
 integrations:{enrollment:(client,id)=>client==='codex'&&id===enrollment.installationId?enrollment:null},attestPeer:async(...args)=>{counters.peer++;const start=performance.now();try{const result=await attestHookPeer(...args);counters.authorized++;return result;}finally{timings.peer.push(performance.now()-start);}}});
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
 if(kind==='remove-second') enrollment.executables=enrollment.executables.filter(value=>value.path!==${JSON.stringify(second)});
 await core.engine.drain();console.log(JSON.stringify({count:core.session.versionCount,counters,timings:{peer:timings.peer.splice(0),admission:timings.admission.splice(0)}}));
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
    os: release(), cpu: cpus()[0]?.model, loadBefore: loadavg(),
    clientSize: (await readFile(client)).length,
    identity: 'REAL_KERNEL_PEERS_AND_AD_HOC_TEST_SIGNATURES', vendorClient: 'SYNTHETIC_ENROLLED_NATIVE_FIXTURE', samples: 60, paths: {} };
  for (const mode of ['off', 'on', 'coexisting-native', 'script', 'unenrolled-path', 'noninteractive', 'changed-script', 'changed-interpreter',
    'remove-second', 'remaining-native', 'input-timeout', 'malformed', 'oversized', 'busy', 'changed-client', 'unavailable']) {
    if (mode === 'changed-client') run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', namespace + '.changed', client]);
    if (mode === 'changed-script') await writeFile(script, '#!synthetic-fixture\nchanged\n');
    if (mode === 'changed-interpreter') {
      await writeFile(script, '#!synthetic-fixture\n');
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', namespace + '.changed-interpreter', interpreter]);
    }
    const beforeState = await command(mode), before = beforeState.count, times = [], totalTimes = [], stages = {};
    const add = (stage, value) => (stages[stage] ??= []).push(value);
    const samples = ['off', 'on', 'busy', 'changed-client', 'unavailable', 'coexisting-native'].includes(mode) ? report.samples : 3;
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      const scriptMode = ['script', 'changed-script', 'changed-interpreter'].includes(mode);
      const selected = scriptMode ? interpreter : mode === 'unenrolled-path' ? unenrolled : mode === 'remove-second' ? second
        : mode === 'remaining-native' ? last : mode === 'coexisting-native' ? (i % 2 ? second : last) : client;
      const child = spawn(selected, scriptMode ? [script] : mode === 'noninteractive' ? ['exec'] : [],
        { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '', measurement = '', stageOutput = '';
      child.stdio[4].on('data', b => { measurement += b.toString(); });
      child.stdio[5].on('data', b => { stageOutput += b.toString(); });
      child.stdout.on('data', b => { stdout += b.toString(); }); child.stderr.on('data', b => { stderr += b.toString(); });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      child.stdin.on('error', () => {});
      const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'native-fixture', turn_id: 'turn', prompt: '\ufeffSynthetic native exact e\u0301\r\n\0' });
      if (mode === 'input-timeout') child.stdin.write(payload);
      else child.stdin.end(mode === 'malformed' ? '{"prompt":"first","prompt":"second"}'
        : mode === 'oversized' ? Buffer.alloc(1024 * 1024 + 1, 65) : payload);
      const result = await done; totalTimes.push(performance.now() - start);
      assert.ok(Number.isFinite(Number(measurement)) && Number(measurement) > 0); times.push(Number(measurement));
      assert.deepEqual(result, { code: 0, signal: null }); assert.equal(stdout, ''); assert.equal(stderr, '');
      await new Promise(resolve => setTimeout(resolve, 20));
      const marks = Object.fromEntries(stageOutput.trim().split('\n').map(line => { const [stage, time] = line.split(' '); return [stage, Number(time)]; }));
      add('mainToExit', Number(measurement) - (marks.main - marks.start));
      for (const [name, start, end] of [['launch', 'start', 'main'], ['bundleSignature', 'main', 'bundle'],
        ['rendezvousConnect', 'bundle', 'connected'], ['residentSignatures', 'connected', 'resident'],
        ['inputAndSend', 'resident', 'sent'], ['admissionRoundTrip', 'sent', 'admitted'], ['releaseRoundTrip', 'admitted', 'released']]) {
        if (Number.isFinite(marks[start]) && Number.isFinite(marks[end])) add(name, marks[end] - marks[start]);
      }
      const drained = await command('drain');
      for (const [name, values] of Object.entries(drained.timings)) for (const value of values) add(name, value);
    }
    const state = await command('drain'), after = state.count, ordered = [...times].sort((a,b) => a-b), p = n => ordered[Math.ceil(n*ordered.length)-1];
    report.paths[mode] = { samples, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maximumMs: p(1), saved: after-before, clientLaunchMaximumMs: Math.max(...totalTimes), counters: state.counters, over250Ms: times.filter(ms=>ms>250).length };
    report.paths[mode].stages = Object.fromEntries(Object.entries(stages).map(([name, values]) => {
      const ordered = values.sort((a,b) => a-b), p = n => ordered[Math.ceil(n * ordered.length)-1];
      return [name, { samples: values.length, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maximumMs: p(1) }];
    }));
    report.paths[mode].samplesMs = times;
    if (['changed-client', 'changed-interpreter', 'changed-script', 'unenrolled-path', 'noninteractive', 'remove-second'].includes(mode)) {
      assert.equal(state.counters.authorized, beforeState.counters.authorized, 'Unenrolled, changed or noninteractive origins must fail native authentication');
    }
    assert.ok(times.every(ms => ms <= 250), JSON.stringify({ mode, times }));
    assert.equal(after-before, ['on', 'coexisting-native', 'script', 'remaining-native'].includes(mode) ? samples : 0, JSON.stringify(report));
  }
  host.stdin.end('{"kind":"stop"}\n');
  await Promise.race([hostFinished, new Promise((_, reject) => setTimeout(() => reject(Error('NATIVE_RUNTIME_STOP_TIMEOUT')), 3000))]);
  report.loadAfter = loadavg();
  report.sources = await Promise.all(['spikes/core/recording-engine.mjs', 'spikes/coding/integrations.mjs',
    'spikes/platform/macos/hook-peer.mjs', 'spikes/coding/native/macos-hook-peer.swift', 'spikes/coding/native/macos-hook-security.swift',
    'spikes/coding/native/macos-hook-receiver.swift', 'spikes/coding/runtime.mjs', 'test/mac-hook-native.mjs'].map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(join(repo, path))).digest('hex') })));
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  if (host && host.exitCode === null) { process.kill(-host.pid, 'SIGKILL'); await hostFinished; }
  await rm(root, { recursive: true, force: true });
}
