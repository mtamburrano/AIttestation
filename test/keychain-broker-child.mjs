import assert from 'node:assert/strict';
import { MacOSKeychainStore } from '../spikes/vault/key-lifecycle.mjs';

// Both broker descriptors belong to this test's parent process. No native app,
// helper, Keychain, inherited configuration or service is contacted.
const store = new MacOSKeychainStore();
let ticks = 0;
const interval = setInterval(() => ticks++, 5);
try {
  const first = store.getAsync('synthetic-first'), second = store.getAsync('synthetic-second');
  assert.throws(() => store.get('synthetic-sync'), /broker unavailable or busy/);
  const values = await Promise.all([first, second]);
  assert.deepEqual(values.map(value => value.toString()), ['SYNTHETIC_FIRST', 'SYNTHETIC_SECOND']);
  values.forEach(value => value.fill(0));
  assert.ok(ticks >= 10, 'the native broker wait must not block the event loop');
  process.stdout.write(JSON.stringify({ ticks, ordered: true }));
} finally { clearInterval(interval); }
