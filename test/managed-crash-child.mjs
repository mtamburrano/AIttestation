import { readFileSync } from 'node:fs';
import { ManagedSponsorship } from '../spikes/managed/service.mjs';
import { MANAGED_NETWORK } from '../spikes/managed/protocol.mjs';

const { directory, token, request, phase, now } = JSON.parse(readFileSync(0, 'utf8'));
const service = new ManagedSponsorship(directory, { now: () => now, sponsor: {
  async prepare() {
    if (phase === 'prepare') process.exit(71);
    return { transactionId: 'C'.repeat(52), network: MANAGED_NETWORK, feeMicroAlgos: 1000,
      signedTransaction: Buffer.from('test-only-crash-transaction').toString('base64') };
  },
  async broadcast() { process.exit(72); },
} });
await service.anchor(token, request);
throw Error('Crash boundary not reached');
