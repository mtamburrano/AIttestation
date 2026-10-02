import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeFrameDecoder, encodeNativeFrame, runNativeHost } from '../spikes/browser/chatgpt/native-host.mjs';
import { parseUniqueJSON } from '../spikes/distribution/unique-json.mjs';
import { artifactJSON, storeArchive } from '../spikes/distribution/artifact-files.mjs';
import { parseBoundedJSON } from '../spikes/recipient/portable.mjs';
import { decodeHook } from '../spikes/coding/protocol.mjs';
import { parseSettings, editSettings, ownedHook } from '../spikes/coding/settings.mjs';
import { zip } from './artifact-policy-fixture.mjs';

const rawFrame = text => {
  const bytes = Buffer.from(text), prefix = Buffer.alloc(4); prefix.writeUInt32LE(bytes.length);
  return Buffer.concat([prefix, bytes]);
};

test('encoded duplicate names are rejected consistently at every external JSON boundary', () => {
  const parsers = [parseUniqueJSON, parseBoundedJSON, text => artifactJSON(Buffer.from(text)),
    text => parseSettings(text, 'json'), text => new NativeFrameDecoder().push(rawFrame(text))];
  for (const key of ['kind', 'prompt', 'hooks', 'source', '__proto__']) {
    for (let position = 0; position < key.length; position++) {
      const escaped = key.slice(0, position) + '\\u' + key.charCodeAt(position).toString(16).padStart(4, '0') + key.slice(position + 1);
      const duplicate = `{"${key}":{},"${escaped}":{}}`;
      for (const text of [duplicate, `{"nested":[${duplicate}]}`])
        for (const parse of parsers) assert.throws(() => parse(text), `${key}/${position}`);
    }
  }
  const text = '{"left":{"kind":1},"right":{"kind":2},"quoted":"{\\\"kind\\\": 3}"}';
  for (const parse of parsers) assert.doesNotThrow(() => parse(text));
});

test('native framing accepts every two-chunk split and rejects finite malformed frames', () => {
  const values = [{ kind: 'FIRST', text: 'synthetic é 🧪' }, { kind: 'SECOND' }];
  const bytes = Buffer.concat(values.map(encodeNativeFrame));
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new NativeFrameDecoder();
    assert.deepEqual([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))], values);
  }
  for (const length of [0, 512 * 1024 + 1, 0xffffffff]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(length);
    assert.throws(() => new NativeFrameDecoder().push(prefix));
  }
  for (const text of ['', 'null', '[]', '{}{}', '{"x":NaN}', Buffer.from([0xff]),
    '{"nested":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}'])
    assert.throws(() => new NativeFrameDecoder().push(rawFrame(text)));
});

test('hook mutation corpus rejects ambiguous authority and malformed encodings', () => {
  const hook = { hook_event_name: 'UserPromptSubmit', session_id: 'synthetic-session', turn_id: 'synthetic-turn',
    prompt_id: '00000000-0000-4000-8000-000000000001', prompt: 'exact synthetic prompt' };
  const bytes = Buffer.from(JSON.stringify(hook));
  for (const client of ['codex', 'claude-code']) {
    assert.equal(decodeHook(client, bytes).text, hook.prompt);
    for (let end = 0; end < bytes.length; end++) assert.throws(() => decodeHook(client, bytes.subarray(0, end)));
    for (const name of ['prompt', 'session_id', 'hook_event_name']) {
      const alias = '\\u' + name.charCodeAt(0).toString(16).padStart(4, '0') + name.slice(1);
      const shadow = bytes.toString().slice(0, -1) + `,"${alias}":"shadow"}`;
      assert.throws(() => decodeHook(client, Buffer.from(shadow)));
    }
    for (const tail of [Buffer.from([0]), Buffer.from([0xc0, 0xaf]), Buffer.from('{}')])
      assert.throws(() => decodeHook(client, Buffer.concat([bytes, tail])));
  }
});

test('TOML token lookalikes preserve unrelated values through install and removal', () => {
  const installationId = '00000000-0000-4000-8000-000000000002';
  const hook = ownedHook('codex', '/synthetic/receiver', installationId);
  for (const lookalike of ['[[hooks.UserPromptSubmit]]', '# comment ] }', 'quotes " \\ newline\n', 'é 🧪']) {
    for (const suffix of ['', '\n[hooks]\nUserPromptSubmit = []\n']) {
      const text = `note = ${JSON.stringify(lookalike)}\ninteger = 9223372036854775807\n${suffix}`;
      const installed = editSettings({ text, format: 'toml', client: 'codex', installationId, next: hook });
      const removed = editSettings({ text: installed.text, format: 'toml', client: 'codex', installationId,
        previous: hook, fragment: installed.fragment });
      assert.equal(removed.text, text);
      assert.equal(parseSettings(installed.text, 'toml').note, lookalike);
    }
  }
  for (const text of ['hooks = {}\nhooks = {}', '[hooks]\nUserPromptSubmit = []\nUserPromptSubmit = []',
    'note = ' + '['.repeat(1001) + '0' + ']'.repeat(1001)]) assert.throws(() => parseSettings(text, 'toml'));
});

test('archive truncations and inconsistent local/directory fields never yield an accepted package', () => {
  for (const compressed of [false, true]) for (const descriptor of [false, true]) {
    const bytes = zip([['fixture.txt', 'synthetic public bytes']], { compressed, descriptor });
    assert.equal(storeArchive(bytes).get('fixture.txt').toString(), 'synthetic public bytes');
    for (let end = 0; end < bytes.length; end++) assert.throws(() => storeArchive(bytes.subarray(0, end)));
    const central = bytes.readUInt32LE(bytes.length - 6);
    for (const offset of [0, 6, 8, 26, 30, central, central + 8, central + 10, central + 16,
      central + 20, central + 24, central + 28, central + 42, bytes.length - 12, bytes.length - 6]) {
      const mutated = Buffer.from(bytes); mutated[offset] ^= 1;
      assert.throws(() => storeArchive(mutated), `${compressed}/${descriptor}/${offset}`);
    }
  }
});

test('nonregular input files fail promptly before any blocking read or client execution', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attestamp-adversarial-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), home = join(root, 'home');
  await mkdir(bin); await mkdir(join(home, '.vscode/extensions'), { recursive: true });
  for (const path of [join(root, 'pipe'), join(bin, 'codex'), join(home, '.vscode/extensions/extensions.json')])
    assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', path]).status, 0);
  const moduleURL = relative => new URL(relative, import.meta.url).href;
  const cases = [
    `const {readOwned}=await import(${JSON.stringify(moduleURL('../spikes/distribution/files.mjs'))}); await readOwned(root+'/pipe');`,
    `const {inspectRecoveryFile}=await import(${JSON.stringify(moduleURL('../spikes/vault/recovery-stream.mjs'))}); inspectRecoveryFile(root+'/pipe',Buffer.alloc(32));`,
    `const {discoverClients}=await import(${JSON.stringify(moduleURL('../spikes/coding/discovery.mjs'))}); await discoverClients({client:'codex',home:root+'/home',applications:root+'/absent',globalBins:[]});`,
    `const {discoverClients}=await import(${JSON.stringify(moduleURL('../spikes/coding/discovery.mjs'))}); await discoverClients({client:'codex',home:root+'/absent',applications:root+'/absent',globalBins:[root+'/bin']});`,
    `const {CodingIntegrations}=await import(${JSON.stringify(moduleURL('../spikes/coding/integrations.mjs'))});
      const manager=await new CodingIntegrations({directory:root+'/support',receiver:root+'/receiver',
      configRoots:{codex:root+'/codex','claude-code':root+'/claude'},setEnabled:async()=>{},codeIdentity:async()=>{throw Error('MUST_NOT_EXECUTE');}}).init();
      await manager.preview({client:'codex',clientExecutable:root+'/pipe'});`,
  ];
  for (const [index, code] of cases.entries()) await t.test(`reader ${index + 1}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const root=process.env.FIXTURE_ROOT; try { ${code} } catch(e) { if(e.message==='MUST_NOT_EXECUTE') process.exit(2); }`],
    { env: { HOME: home, PATH: '/usr/bin:/bin', FIXTURE_ROOT: root }, timeout: 1500, encoding: 'utf8' });
    assert.equal(result.error, undefined, 'reader must reject a FIFO without waiting for a writer');
    assert.equal(result.status, 0, result.stderr);
  });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../spikes/recipient/verify.mjs', import.meta.url)), join(root, 'pipe')],
    { env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 1500, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'recipient must reject a FIFO without waiting for a writer');
  assert.equal(result.status, 1); assert.match(result.stderr, /Regular local file/);
});

test('rendezvous size and hardlink checks happen before parsing or connection', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attestamp-rendezvous-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const large = join(root, 'large.json'), original = join(root, 'original.json'), alias = join(root, 'alias.json');
  await writeFile(large, ' '.repeat(16 * 1024 + 1), { mode: 0o600 });
  await writeFile(original, '{}', { mode: 0o600 }); await link(original, alias);
  for (const path of [large, alias]) await assert.rejects(runNativeHost({
    extensionOrigin: 'chrome-extension://' + 'a'.repeat(32) + '/', rendezvousPath: path,
    connect: () => { throw Error('MUST_NOT_CONNECT'); },
  }), error => error.code === 'UNSAFE_INSTALL_FILE');
});
