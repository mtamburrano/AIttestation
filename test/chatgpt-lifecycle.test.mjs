import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { workerFixture, testTab, turn } from './chrome-worker-fixture.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

test('startup and overlapping update recovery inject only fixed scripts into supported top-level documents', async t => {
  const calls = [];
  const f = await workerFixture({ query: async () => [testTab(),
    testTab({ id: 18, url: 'https://chatgpt.com/settings' }), testTab({ id: 19, incognito: true }),
    testTab({ id: 20, discarded: true }), testTab({ id: 21, url: 'https://chatgpt.com/c/WEB:11111111-2222-4333-8444-555555555555' })],
    executeScript: async input => { calls.push(structuredClone(input)); await turn();
      return [{ frameId: 0, documentId: `document-${input.target.tabId}` }]; } });
  t.after(() => f.close());
  f.chrome.runtime.onInstalled.emit({ reason: 'update' }); f.chrome.runtime.onInstalled.emit({ reason: 'install' });
  await until(() => calls.length === 4); await turn();
  assert.deepEqual(calls.filter(value => value.world === 'ISOLATED').map(value => value.target.tabId).sort(), [17, 21]);
  for (const id of [17, 21]) {
    assert.deepEqual(calls.filter(value => value.target.tabId === id), [
      { target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', files: ['content-script.js'], injectImmediately: true },
      { target: { tabId: id, documentIds: [`document-${id}`] }, world: 'MAIN', files: ['fetch-observer.js'], injectImmediately: true },
    ]);
  }
});

for (const failure of ['revoked initially', 'revoked after relay', 'too many tabs', 'document disappeared', 'wrong frame', 'missing document']) {
  test(`recovery fails closed when ${failure}`, async t => {
    const calls = []; let granted = failure !== 'revoked initially';
    const f = await workerFixture({ permission: async () => granted,
      query: async () => Array.from({ length: failure === 'too many tabs' ? 33 : 1 }, (_, index) => testTab({ id: 17 + index })),
      executeScript: async input => {
        calls.push(structuredClone(input));
        if (failure === 'document disappeared') throw Error('SYNTHETIC_DOCUMENT_GONE');
        if (failure === 'revoked after relay') granted = false;
        return [{ frameId: failure === 'wrong frame' ? 1 : 0, documentId: failure === 'missing document' ? '' : 'document-17' }];
      } });
    t.after(() => f.close());
    for (let i = 0; i < 5; i++) await turn();
    assert.equal(calls.length, ['revoked initially', 'too many tabs'].includes(failure) ? 0 : 1);
    assert.ok(calls.every(value => value.world === 'ISOLATED'));
  });
}

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/attestamp-lifecycle-test-'); let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root); await f.recording(true); return f;
}

test('repeated reinjection preserves one observer, one relay and current consent', async t => {
  const f = await fixture(t), page = f.pages.get(17), policy = (await f.refresh()).policy;
  for (let i = 0; i < 4; i++) page.reinject();
  assert.equal((await f.refresh()).policy.token, policy.token);
  await page.request('ON_AFTER_REINJECTION');
  await until(() => f.runtime.session.receipts.list().length === 1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(page.document.querySelectorAll('#attestamp-recording-status').length, 1);
  await f.recording(false); page.reinject();
  await page.request('OFF_AFTER_REINJECTION'); await turn(); await turn();
  assert.equal(f.runtime.session.receipts.list().length, 1);
  assert.equal(page.feedback, ''); assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});

test('an invalidated extension context removes stale status and retires pending relay work', async t => {
  const f = await fixture(t), page = f.pages.get(17), held = page.holdTransport('request');
  await page.request('STALE_EXTENSION_REQUEST'); await until(() => held.messages.length === 1);
  page.invalidateExtension();
  await until(() => page.document.querySelectorAll('#attestamp-recording-status').length === 0);
  held.release(); await turn(); await turn();
  assert.equal(f.deliveries.length, 0); assert.equal(f.runtime.session.receipts.list().length, 0);
  await page.request('PROVIDER_CONTINUES'); await turn();
  assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});
