import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { parseBoundedJSON, verifyPortable, RECIPIENT_LIMITS } from './portable.mjs';

export function readBoundedFile(path, maximum) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw Error('Regular local file within input limit required');
    const buffer = Buffer.alloc(maximum + 1); let offset = 0, amount;
    while (offset <= maximum && (amount = readSync(fd, buffer, offset, buffer.length - offset, null))) offset += amount;
    if (offset > maximum) throw Error('Input size limit');
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}

try {
  let bundle, trust = null;
  if (process.argv.length === 3 && process.argv[2] === '--stdin') {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length; if (size > 2 * RECIPIENT_LIMITS.wire + RECIPIENT_LIMITS.trust) throw Error('Input size limit');
      chunks.push(chunk);
    }
    const request = parseBoundedJSON(Buffer.concat(chunks), 2 * RECIPIENT_LIMITS.wire + RECIPIENT_LIMITS.trust);
    bundle = request.bundle;
    if (request.trust !== null) trust = parseBoundedJSON(request.trust, RECIPIENT_LIMITS.trust);
  } else {
    if (process.argv.length < 3 || process.argv.length > 4) throw Error('Usage: node verify.mjs evidence.json [independently-selected-trust.json]');
    bundle = readBoundedFile(process.argv[2], RECIPIENT_LIMITS.wire);
    if (process.argv[3]) trust = parseBoundedJSON(readBoundedFile(process.argv[3], RECIPIENT_LIMITS.trust), RECIPIENT_LIMITS.trust);
  }
  const report = verifyPortable(bundle, trust);
  process.stdout.write(JSON.stringify(report));
  if (!report.records.length || report.records.some(r => r.structure !== 'VALID' || r.integrity !== 'VALID'
      || r.keyAttribution !== 'SIGNATURE_VALID' || r.anchor !== 'CONSENSUS_VERIFIED' || r.timestamp !== 'BLOCK_HASH_BOUND')) process.exitCode = 2;
} catch (error) { process.stderr.write(JSON.stringify({ error: error.message })); process.exitCode = 1; }
