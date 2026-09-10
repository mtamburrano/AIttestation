import { DurableVault } from '../spikes/vault/key-lifecycle.mjs';
import { FileKeyStore } from './file-key-store.mjs';

if (process.argv.length !== 4) throw Error('Usage: node vault-key-rotation-child.mjs VAULT_DIRECTORY KEY_STORE_DIRECTORY');
const vault = DurableVault.open(process.argv[2], {
  keyStore: new FileKeyStore(process.argv[3]),
  fault: phase => { if (phase === 'rotation-after-db-commit') process.kill(process.pid, 'SIGKILL'); },
});
vault.rotateVaultKey();
throw Error('Expected rotation process to be killed');
