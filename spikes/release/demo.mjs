import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from './fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'provenance-release-test-'));
const fixture = await startFixture(directory);
console.log(`Synthetic-only fixture: ${fixture.url}\nPlaintext test journal: ${directory}`);
process.on('SIGINT', async () => { await fixture.close(); process.exit(0); });
