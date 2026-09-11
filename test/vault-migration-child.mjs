import { readFileSync } from 'node:fs';
import { Vault } from '../spikes/vault/vault.mjs';

const [, , directory, keyPath, phase] = process.argv;
new Vault(directory, readFileSync(keyPath), null, { fault: observed => {
  if (observed === phase) process.kill(process.pid, 'SIGKILL');
} }).close();
