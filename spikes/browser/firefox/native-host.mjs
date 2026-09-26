import { homedir } from 'node:os';
import { join } from 'node:path';
import { runNativeHost, FIREFOX_NATIVE_BRIDGE_PROFILE } from '../chatgpt/native-host.mjs';
import { FIREFOX_EXTENSION_ID } from '../shared/profiles.mjs';

runNativeHost({ extensionOrigin: `firefox-extension:${FIREFOX_EXTENSION_ID}`, profile: FIREFOX_NATIVE_BRIDGE_PROFILE,
  rendezvousPath: join(homedir(), 'Library', 'Application Support', 'Private Provenance', 'firefox-bridge.json') }).catch(() => {
  process.stdin.destroy(); process.stdout.destroy(); process.exitCode = 1;
});
