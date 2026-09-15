import test from 'node:test';
import assert from 'node:assert/strict';
import { pageFixture, pageCommand } from './chatgpt-page-fixture.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { access, readFile, readdir } from 'node:fs/promises';
import { copyApplicationResource } from '../spikes/distribution/package-resources.mjs';

test('removed page Send commands reject without changing a draft or clicking Send', async t => {
  const page = pageFixture({ draft: 'PRESERVED_SYNTHETIC_DRAFT' }); t.after(() => page.close());
  for (const kind of ['PAP_RELEASE', 'PAP_CHECK_RELEASE', 'PAP_RELEASE_CHECKED', 'PROTECT_AND_SEND']) {
    const result = await page.send({ ...pageCommand('FORGED'), kind });
    assert.equal(result.error, 'UNSUPPORTED_PAGE_COMMAND');
  }
  assert.equal(page.text, 'PRESERVED_SYNTHETIC_DRAFT'); assert.equal(page.clicks(), 0); assert.equal(page.injections(), 0);
});
test('OFF inspection, typing and synthetic messages do not read any draft bytes', async t => {
  const page = pageFixture({ textarea: true }); t.after(() => page.close());
  let reads = 0; Object.defineProperty(page.editor, 'value', { get() { reads++; throw Error('DRAFT_READ_WHILE_OFF'); } });
  await page.inspect(); page.changed(); page.event('input');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(reads, 0); assert.equal(page.injections(), 0); assert.equal(page.clicks(), 0);
});
test('unsupported sender and obsolete page contracts cannot change capture policy', async t => {
  const page = pageFixture(); t.after(() => page.close());
  for (const changes of [{ pageContract: 'chatgpt-web-text/2026-09-14' }, {}]) {
    const result = await page.send({ kind: 'PAP_INSPECT', pageContract: CHATGPT_PAGE_CONTRACT, ...changes },
      changes.pageContract ? undefined : { id: 'untrusted' });
    assert.equal(result.surfaceSupported, false);
  }
});

test('shipping source inventory contains no provider Send executor or dormant legacy entrypoint', async () => {
  const removed = ['spikes/release/runtime.mjs', 'spikes/release/composer.js', 'spikes/release/demo.mjs',
    'spikes/demonstrator/session.mjs', 'spikes/demonstrator/server.mjs',
    'spikes/demonstrator/main.mjs', 'spikes/demonstrator/build-macos.mjs', 'spikes/demonstrator/live-validation.mjs',
    'spikes/browser/chatgpt/product-app.js', 'spikes/browser/chatgpt/product.html'];
  for (const path of removed) await assert.rejects(access(path), { code: 'ENOENT' });
  const scan = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (!['testdata', 'bin'].includes(entry.name)) await scan(path); }
      else if (copyApplicationResource(path) && /\.(?:mjs|js|html)$/.test(path)) assert.doesNotMatch(await readFile(path, 'utf8'),
        /PAP_(?:CHECK_)?RELEASE\b|PROTECT_AND_SEND|DEVELOPMENT_FREEZE|ReleaseRuntime|VaultReleaseStore|handleRelease|sendRelease/, path);
    }
  };
  await scan('spikes');
  const scripts = JSON.parse(await readFile('package.json')).scripts;
  assert.ok(Object.keys(scripts).every(name => !name.startsWith('demo:') && name !== 'build:consumer'));
});
