import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

async function fixture() {
  // Run the shipped UI with an in-memory DOM and API. No installed browser,
  // executable discovery, user configuration or provider connection is involved.
  const elements = new Map();
  const element = (tag = 'div') => ({ tag, value: '', textContent: '', checked: false, disabled: false, hidden: false, children: [], listeners: {},
    append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
    addEventListener(kind, fn) { this.listeners[kind] = fn; }, setAttribute() {}, closest() { return null; },
    after(value) { elements.set(value.id, value); }, getBoundingClientRect() { return { top: 0, bottom: 1 }; },
    scrollIntoView() {}, focus() {} });
  const html = await readFile(new URL('../spikes/browser/chatgpt/dashboard.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) elements.set(match[2], element(match[1]));
  const get = id => { assert.ok(elements.has(id), `Missing UI element: ${id}`); return elements.get(id); };
  const requests = [], selected = [{ path: '/synthetic/desktop' }, { path: '/synthetic/ide' }];
  const discovery = { limit: 4, candidates: selected.map((value, index) => ({ ...value,
    name: index ? 'VS Code · Codex' : 'ChatGPT desktop', version: '2.0' })) };
  const plan = { operationId: 'synthetic-preview', consent: 'Explicit selection consent',
    changes: [{ file: '/synthetic/config/hooks.json' }], executables: selected,
    removedExecutables: [{ path: '/synthetic/retired' }] };
  const pending = new Map(), response = (value, ok = true) => ({ ok, json: async () => value });
  const defer = path => {
    const gate = Promise.withResolvers(), queue = pending.get(path) ?? []; queue.push(gate.promise); pending.set(path, queue);
    return { resolve: value => gate.resolve(response(value)),
      fail: () => gate.resolve(response({ error: 'CODEX_DUAL_HOOK_CONFIGURATION' }, false)),
      reject: () => gate.reject(Error('synthetic network failure')) };
  };
  const context = createContext({ document: { getElementById: id => elements.get(id) ?? null, createElement: element,
    querySelectorAll: tag => [...elements.values()].filter(value => tag.startsWith('.') ? value.className === tag.slice(1) : value.tag === tag) },
    location: { hash: '', href: 'http://fixture.invalid/dashboard' }, history: { replaceState() {} },
    sessionStorage: { getItem: () => '', setItem() {} }, URL, innerHeight: 100, setInterval() {}, addEventListener() {},
    fetch: async (path, options) => {
      if (path === '/dashboard/state') return new Promise(() => {});
      assert.ok(['/integrations/discover', '/integrations/preview', '/integrations/apply'].includes(path));
      requests.push({ path, data: JSON.parse(options.body) });
      return pending.get(path)?.shift() ?? response(path === '/integrations/discover' ? discovery : path === '/integrations/preview' ? plan : {});
    } });
  runInContext(await readFile(new URL('../spikes/browser/chatgpt/dashboard.js', import.meta.url), 'utf8'), context);
  // Status polling is unrelated to selection consent; keep the real action,
  // discovery, preview and Apply handlers and replace only the subsequent refresh.
  runInContext('refresh = async () => {};', context);
  get('integration-client').value = 'codex';
  const click = id => get(id).onclick();
  const edit = (id, value, kind = 'input') => { get(id).value = value; get(id).listeners[kind](); };
  const consent = () => { get('integration-consent').checked = true; get('integration-consent').listeners.change(); };
  const calls = path => requests.filter(value => value.path === path).map(value => value.data);
  const choose = (index, checked) => {
    const checkbox = get('integration-candidates').children[index].children[0]; checkbox.checked = checked; checkbox.listeners.change();
  };
  return { get, context, selected, discovery, plan, defer, click, edit, consent, calls, choose };
}

test('Connections UI submits the complete Codex selection, displays removals and invalidates consent after edits', async () => {
  const { get, context, selected, calls } = await fixture();
  get('integration-client').value = 'codex'; get('integration-executable').value = selected.map(value => value.path).join('\n');
  await runInContext("previewIntegration('install')", context);
  assert.deepEqual(calls('/integrations/preview'), [{ client: 'codex', action: 'install', clientExecutables: selected }]);
  const text = get('integration-selection').children.map(value => value.textContent).join('\n');
  assert.match(text, /record together/); for (const value of selected) assert.ok(text.includes(value.path));
  assert.ok(text.includes('Will stop recording: /synthetic/retired'));
  assert.equal(get('integration-apply').disabled, true);
  get('integration-consent').checked = true; get('integration-consent').listeners.change();
  assert.equal(get('integration-apply').disabled, false);
  get('integration-executable').value = '/synthetic/replacement'; get('integration-executable').listeners.input();
  assert.equal(get('integration-consent').checked, false); assert.equal(get('integration-apply').disabled, true);
  assert.equal(get('integration-preview-box').hidden, true);
  get('integration-executable').value = '';
  await runInContext('discoverIntegrations()', context);
  assert.match(get('integration-discovery-status').textContent, /Detected 2/);
  assert.match(get('integration-candidates').children[1].textContent, /VS Code · Codex · 2.0/);
  for (const label of get('integration-candidates').children) label.children[0].checked = true;
  await runInContext("previewIntegration('install')", context);
  assert.deepEqual(calls('/integrations/preview').at(-1), { client: 'codex', action: 'install', clientExecutables: selected });
  get('integration-consent').checked = true;
  get('integration-candidates').children[0].children[0].listeners.change();
  assert.equal(get('integration-consent').checked, false);
  get('integration-client').value = 'firefox-chatgpt'; get('integration-client').listeners.change();
  assert.match(get('integration-discovery-status').textContent, /no Store or signing action/);
  assert.equal(get('integration-candidates').children.length, 0);
  assert.match(runInContext('integrationErrors.CODEX_DUAL_HOOK_CONFIGURATION', context), /Neither file was changed/);
});

const edits = [
  ['client', f => f.edit('integration-client', 'claude-code', 'change')],
  ['client A to B to A', f => { f.edit('integration-client', 'claude-code', 'change'); f.edit('integration-client', 'codex', 'change'); }],
  ...['executable', 'root', 'interpreter'].map(field => [field, f => f.edit(`integration-${field}`, '/synthetic/changed')]),
];
for (const kind of ['discover', 'preview']) for (const [name, change] of edits) {
  for (const outcome of ['success', 'API error', 'network error']) test(`late ${kind} ${outcome} is discarded after ${name} changes`, async () => {
    const f = await fixture(), gate = f.defer(`/integrations/${kind}`);
    const pending = f.click(`integration-${kind}`);
    change(f); f.get('message').textContent = 'Current selection feedback';
    if (outcome === 'success') gate.resolve(kind === 'discover' ? f.discovery : f.plan);
    else if (outcome === 'API error') gate.fail(); else gate.reject();
    await pending;
    assert.equal(f.get('message').textContent, 'Current selection feedback');
    assert.equal(f.get('integration-preview-box').hidden, true);
    assert.equal(f.get('integration-candidates').children.length, 0);
    assert.equal(f.get('integration-consent').checked, false);
    f.consent(); assert.equal(f.get('integration-apply').disabled, true);
    await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
  });
}

for (const outcome of ['success', 'API error']) test(`late preview ${outcome} is discarded after candidate selection changes and changes back`, async () => {
  const f = await fixture(); await f.click('integration-discover'); f.choose(0, true);
  const gate = f.defer('/integrations/preview'), pending = f.click('integration-preview');
  f.choose(0, false); f.choose(1, true); f.choose(1, false); f.choose(0, true);
  f.get('message').textContent = 'Current selection feedback';
  if (outcome === 'success') gate.resolve(f.plan); else gate.fail();
  await pending;
  assert.equal(f.get('message').textContent, 'Current selection feedback');
  assert.equal(f.get('integration-preview-box').hidden, true);
  f.consent(); await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
});

test('late removal preview cannot authorize the previous client operation', async () => {
  const f = await fixture(), gate = f.defer('/integrations/preview'), pending = f.click('integration-remove');
  assert.deepEqual(f.calls('/integrations/preview'), [{ client: 'codex', action: 'remove' }]);
  f.edit('integration-client', 'claude-code', 'change'); gate.resolve(f.plan); await pending;
  f.consent(); await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
});

for (const kind of ['discover', 'preview']) for (const staleError of [false, true]) test(`newer ${kind} response survives an older ${staleError ? 'error' : 'success'} for the same selection`, async () => {
  const f = await fixture(), older = f.defer(`/integrations/${kind}`);
  const expression = kind === 'discover' ? 'discoverIntegrations()' : "previewIntegration('install')";
  const oldRequest = runInContext(expression, f.context), newer = f.defer(`/integrations/${kind}`);
  const newRequest = runInContext(expression, f.context);
  const result = kind === 'discover' ? { limit: 4, candidates: [{ path: '/synthetic/new', name: 'New installation', version: '3.0' }] }
    : { ...f.plan, operationId: 'current-operation', consent: 'Current consent' };
  newer.resolve(result); await newRequest;
  f.consent(); f.get('message').textContent = 'Current selection feedback';
  if (staleError) older.fail(); else older.resolve(kind === 'discover' ? f.discovery : f.plan);
  await oldRequest;
  assert.equal(f.get('message').textContent, 'Current selection feedback');
  if (kind === 'discover') {
    assert.equal(f.get('integration-candidates').children.length, 1);
    assert.match(f.get('integration-candidates').children[0].textContent, /New installation/);
    await f.click('integration-preview');
    assert.deepEqual(f.calls('/integrations/preview').at(-1).clientExecutables, [{ path: '/synthetic/new' }]);
  } else {
    assert.equal(f.get('integration-consent-text').textContent, 'Current consent');
    await f.click('integration-apply');
    assert.deepEqual(f.calls('/integrations/apply'), [{ operationId: 'current-operation', consent: true }]);
  }
});

for (const kind of ['discover', 'preview']) test(`current ${kind} errors remain visible and do not authorize Apply`, async () => {
  const f = await fixture(), gate = f.defer(`/integrations/${kind}`), pending = f.click(`integration-${kind}`);
  gate.fail(); await pending;
  assert.match(f.get('message').textContent, /Neither file was changed/);
  assert.equal(f.get('integration-preview-box').hidden, true);
  f.consent(); await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
});

for (const kind of ['discover', 'preview']) test(`starting ${kind === 'discover' ? 'preview' : 'discovery'} invalidates pending ${kind}`, async () => {
  const f = await fixture(), gate = f.defer(`/integrations/${kind}`);
  const pending = runInContext(kind === 'discover' ? 'discoverIntegrations()' : "previewIntegration('install')", f.context);
  await runInContext(kind === 'discover' ? "previewIntegration('install')" : 'discoverIntegrations()', f.context);
  gate.resolve(kind === 'discover' ? f.discovery : f.plan); await pending;
  assert.equal(f.get('integration-preview-box').hidden, kind === 'preview');
  assert.equal(f.get('integration-candidates').children.length, kind === 'preview' ? 2 : 0);
  f.consent(); await f.click('integration-apply');
  assert.deepEqual(f.calls('/integrations/apply'), kind === 'preview' ? [] : [{ operationId: f.plan.operationId, consent: true }]);
});

for (const field of ['client', 'executable', 'root', 'interpreter', 'candidate']) test(`Apply rechecks the accepted ${field} snapshot even without an edit event`, async () => {
  const f = await fixture(); await f.click('integration-discover'); f.choose(0, true);
  await f.click('integration-preview'); f.consent(); assert.equal(f.get('integration-apply').disabled, false);
  if (field === 'candidate') f.get('integration-candidates').children[0].children[0].checked = false;
  else f.get(`integration-${field}`).value = field === 'client' ? 'claude-code' : '/synthetic/changed';
  await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
  assert.equal(f.get('integration-preview-box').hidden, true);
  assert.equal(f.get('integration-consent').checked, false);
});

test('a fresh preview needs fresh explicit consent before the shipped Apply handler dispatches it', async () => {
  const f = await fixture(); await f.click('integration-preview');
  await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
  f.consent(); f.edit('integration-client', 'claude-code', 'change');
  const gate = f.defer('/integrations/preview'), pending = f.click('integration-preview');
  f.get('integration-consent').checked = true;
  gate.resolve({ ...f.plan, operationId: 'claude-operation' }); await pending;
  assert.equal(f.get('integration-consent').checked, false);
  await f.click('integration-apply'); assert.deepEqual(f.calls('/integrations/apply'), []);
  f.consent(); await f.click('integration-apply');
  assert.deepEqual(f.calls('/integrations/apply'), [{ operationId: 'claude-operation', consent: true }]);
});
