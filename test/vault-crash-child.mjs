import { readFileSync } from 'node:fs';
import { Vault } from '../spikes/vault/vault.mjs';
const [directory, keyPath, phase] = process.argv.slice(2);
const key = readFileSync(keyPath);
const vault = new Vault(directory, key, undefined, { fault: at => { if (phase === at) process.kill(process.pid, 'SIGKILL'); } });
const record = vault.capture(Buffer.from('synthetic child exact\0\r\n☕'));
process.stdout.write(`${record.recordDigest}\n`, () => process.kill(process.pid, 'SIGKILL'));
