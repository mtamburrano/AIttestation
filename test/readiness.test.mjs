import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateReadinessInputs } from '../spikes/distribution/readiness-plan.mjs';
import { validateBuildConfig } from '../spikes/distribution/release-inputs.mjs';

const root = new URL('../', import.meta.url);
test('dry-run release plan binds notes/version/browser channels and confers no signed-release authority', async () => {
  const plan = JSON.parse(await readFile(new URL('spikes/distribution/release-plan.json', root)));
  const inputs = { changelog: await readFile(new URL('CHANGELOG.md', root), 'utf8'),
    notes: await readFile(new URL('docs/RELEASE-NOTES.md', root), 'utf8'), browserVersions: [plan.browserVersion, plan.browserVersion] };
  const result = validateReadinessInputs(plan, inputs);
  assert.equal(result.authority, 'NONE'); assert.equal(result.development.releaseReady, false);
  assert.equal(result.plannedChannels[0].updaterEnabled, false); assert.equal(result.plannedChannels[1].stableManifest, 'stable.json');
  assert.match(result.plannedChannels[1].artifactName, /^Private-Provenance-/);
  for (const patch of [{ intent: 'PUBLISH' }, { version: '../escape' }, { sequence: 0 }, { notes: '../private' }, { browserVersion: '9.9.9' }])
    assert.throws(() => validateReadinessInputs({ ...plan, ...patch }, inputs));
  assert.throws(() => validateReadinessInputs(plan, { ...inputs, notes: 'Unversioned notes' }));
  assert.throws(() => validateBuildConfig({ ...plan, releaseChannel: 'production' }));
  assert.throws(() => validateBuildConfig({ ...plan, releaseChannel: 'release-candidate' }));
});
