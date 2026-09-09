import { readFileSync, statSync } from 'node:fs';
import { verifyDisclosure } from './records.mjs';
import { LIMITS } from './format.mjs';

// Explicit local file only. No network loads, credential lookup or archive extraction.
const path = process.argv[2];
try {
  if (!path || process.argv.length !== 3) throw Error('Usage: node spikes/vault/verify.mjs <disclosure.json>');
  if (statSync(path).size > LIMITS.wire) throw Error('LIMIT_EXCEEDED');
  const report = verifyDisclosure(readFileSync(path));
  console.log(JSON.stringify(report, null, 2));
  if (report.records.some(r => r.structure !== 'VALID' || r.integrity !== 'VALID' || r.keyAttribution !== 'SIGNATURE_VALID')) process.exitCode = 1;
} catch (e) { console.error(JSON.stringify({ error: e.code ?? 'INVALID', message: e.message })); process.exitCode = 1; }
