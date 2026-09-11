import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keys, parseCanonical } from '../vault/format.mjs';
import { MANAGED_NETWORK } from './protocol.mjs';
import { ManagedSponsorship } from './service.mjs';
import { algorandSponsor } from './algorand.mjs';
import { startManagedServer } from './http.mjs';

export async function runServiceCommand(args) {
  const [configuration, action, accountId, paidThrough] = args;
  if (!configuration || !isAbsolute(configuration)) throw Error('Absolute service configuration path required');
  const config = parseCanonical((await readFile(configuration, 'utf8')).trim(), 4096);
  keys(config, ['directory', 'network', 'port', 'seedPath', 'expectedAddress']);
  if (config.network !== MANAGED_NETWORK || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw Error('Explicit TestNet service configuration required');
  }
  if (!['serve', 'provision', 'renew', 'rotate'].includes(action)) throw Error('Expected serve, provision, renew or rotate');
  const service = new ManagedSponsorship(config.directory, { sponsor: algorandSponsor(config) });
  try {
    if (action === 'serve') {
      if (args.length !== 2) throw Error('Unexpected service arguments');
      const server = await startManagedServer(service, { port: config.port });
      return { origin: server.origin, close: async () => { await server.close(); service.close(); } };
    }
    let result;
    if (action === 'provision' && args.length === 3) result = service.provision({ paidThrough: Date.parse(accountId) });
    else if (action === 'renew' && args.length === 4) {
      service.setSubscription(accountId, Date.parse(paidThrough)); result = { accountId, updated: true };
    } else if (action === 'rotate' && args.length === 3) result = service.rotateAccessCode(accountId);
    else throw Error('Invalid account operation arguments');
    service.close(); return result;
  } catch (error) { service.close(); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServiceCommand(process.argv.slice(2)).then(result => {
    if (result.close) {
      process.stdout.write(`Managed TestNet service listening at ${result.origin}\n`);
      const close = () => result.close().then(() => process.exit(0));
      process.once('SIGINT', close); process.once('SIGTERM', close);
    } else process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(() => { process.stderr.write('Managed service command failed; check explicit configuration and account arguments.\n'); process.exitCode = 1; });
}
