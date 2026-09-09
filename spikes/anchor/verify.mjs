import { readFileSync, statSync } from 'node:fs';
import { parseCanonical, LIMITS } from '../vault/format.mjs';
import { verifyAnchor } from './verifier.mjs';

try {
  const [bundlePath, rootsPath, recordDigest] = process.argv.slice(2);
  if (process.argv.length !== 5) throw Error('Usage: node spikes/anchor/verify.mjs <bundle.json> <independent-trust.json> <expected-record-digest>');
  const readBounded = path => {
    if (statSync(path).size > 8 * LIMITS.manifest) throw Error('LIMIT_EXCEEDED'); return readFileSync(path);
  };
  const result = verifyAnchor(readBounded(bundlePath), parseCanonical(readBounded(rootsPath)), recordDigest);
  console.log(JSON.stringify(result, null, 2));
  if (!result.independentlyVerified) process.exitCode = 1;
} catch (e) { console.error(JSON.stringify({ error: e.code ?? 'INVALID', message: e.message })); process.exitCode = 1; }
