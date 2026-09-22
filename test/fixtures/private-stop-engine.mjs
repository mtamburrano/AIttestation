import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { startPackagedChatGPT } from '../../spikes/browser/chatgpt/runtime-main.mjs';
import { MemoryKeyStore } from '../../spikes/vault/key-lifecycle.mjs';
import { publishRuntimeState } from '../../spikes/development/runtime-state.mjs';
import { FAST_CONFIRM_PROFILE } from '../../spikes/anchor/algorand/fast-confirm.mjs';

const paths = JSON.parse(process.argv[2]);
for (const path of Object.values(paths)) assert.match(path, /^\/private\/tmp\/attestamp-stop-test-[^/]+(?:\/[^/]+)?$/);
const runtime = await startPackagedChatGPT({ supportDirectory: paths.support, keyStore: new MemoryKeyStore(),
  managed: null, installation: null, fastTrust: { profile: FAST_CONFIRM_PROFILE },
  attestPeer: () => { throw Error('NO_NATIVE_PEER_FIXTURE'); },
  collectFast: () => { throw Error('NO_ANCHOR_FIXTURE'); },
});
const locator = await publishRuntimeState(paths.control, runtime);
process.once('beforeExit', () => unlink(locator));
process.stdout.write('READY\n');
