import { readFileSync, statSync } from 'node:fs';
import { verifyBundle } from './verification.mjs';
try {
  if (process.argv.length !== 4) throw Error('Usage: node spikes/demonstrator/verify.mjs export.json independent-trust.json');
  const inputs = process.argv.slice(2).map(path => {
    if (statSync(path).size > 16 * 1024 * 1024) throw Error('Import limit');
    return JSON.parse(readFileSync(path, 'utf8'));
  });
  const report = verifyBundle(...inputs); console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
} catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
