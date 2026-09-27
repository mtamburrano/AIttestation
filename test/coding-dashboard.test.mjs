import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

test('Connections UI submits the complete Codex selection, displays removals and invalidates consent after edits', async () => {
  // Run the shipped UI with an in-memory DOM and API. No installed browser,
  // executable discovery, user configuration or provider connection is involved.
  const elements = new Map();
  const element = (tag = 'div') => ({ tag, value: '', textContent: '', checked: false, disabled: false, hidden: false, children: [], listeners: {},
    append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
    addEventListener(kind, fn) { this.listeners[kind] = fn; } });
  const html = await readFile(new URL('../spikes/browser/chatgpt/dashboard.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) elements.set(match[2], element(match[1]));
  const get = id => { assert.ok(elements.has(id), `Missing UI element: ${id}`); return elements.get(id); };
  const requests = [], selected = [{ path: '/synthetic/desktop' }, { path: '/synthetic/ide' }];
  const context = createContext({ document: { getElementById: get, createElement: element,
    querySelectorAll: tag => [...elements.values()].filter(value => value.tag === tag) },
    location: { hash: '', href: 'http://fixture.invalid/dashboard' }, history: { replaceState() {} },
    sessionStorage: { getItem: () => '', setItem() {} }, URL, setInterval() {}, addEventListener() {},
    fetch: async (path, options) => {
      if (path === '/dashboard/state') return new Promise(() => {});
      assert.equal(path, '/integrations/preview'); requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ operationId: 'synthetic-preview', consent: 'Explicit selection consent',
        changes: [{ file: '/synthetic/config/hooks.json' }], executables: selected,
        removedExecutables: [{ path: '/synthetic/retired' }] }) };
    } });
  runInContext(await readFile(new URL('../spikes/browser/chatgpt/dashboard.js', import.meta.url), 'utf8'), context);
  get('integration-client').value = 'codex'; get('integration-executable').value = selected.map(value => value.path).join('\n');
  await runInContext("previewIntegration('install')", context);
  assert.deepEqual(requests, [{ client: 'codex', action: 'install', clientExecutables: selected }]);
  const text = get('integration-selection').children.map(value => value.textContent).join('\n');
  assert.match(text, /record together/); for (const value of selected) assert.ok(text.includes(value.path));
  assert.ok(text.includes('Will stop recording: /synthetic/retired'));
  assert.equal(get('integration-apply').disabled, true);
  get('integration-consent').checked = true; get('integration-consent').listeners.change();
  assert.equal(get('integration-apply').disabled, false);
  get('integration-executable').value = '/synthetic/replacement'; get('integration-executable').listeners.input();
  assert.equal(get('integration-consent').checked, false); assert.equal(get('integration-apply').disabled, true);
  assert.equal(get('integration-preview-box').hidden, true);
});
