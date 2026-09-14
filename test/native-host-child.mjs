import { runNativeHost } from '../spikes/browser/chatgpt/native-host.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';

// Only this fixture accepts an explicit temporary rendezvous and short timeout.
// The signed product host keeps its fixed arguments and owner-derived home.
await runNativeHost({ extensionOrigin: `chrome-extension://${CHATGPT_EXTENSION_ID}/`,
  rendezvousPath: process.argv[2], handshakeTimeoutMs: Number(process.argv[3]),
  onClose: code => process.stderr.write(`${code}\n`),
}).catch(() => {
  process.stdin.destroy(); process.stdout.destroy(); process.exitCode = 1;
});
