import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeHost } from '../browser/chatgpt/native-host.mjs';
import { AGENT_OPT_IN, validateAgent } from './agent-environment.mjs';
import { privateJSON } from './environment.mjs';

try {
  const config = await privateJSON(fileURLToPath(new URL('private-development.json', import.meta.url)));
  const paths = await validateAgent(config.agent, AGENT_OPT_IN);
  await runNativeHost({ extensionOrigin: process.argv[2], rendezvousPath: join(paths.support, 'browser-bridge.json') });
} catch {
  process.stderr.write('AGENT_NATIVE_BRIDGE_UNAVAILABLE\n'); process.exitCode = 1;
  process.stdin.destroy(); process.stdout.destroy();
}
