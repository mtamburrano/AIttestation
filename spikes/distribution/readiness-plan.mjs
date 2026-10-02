import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, keys } from '../vault/format.mjs';
import { sha256 } from './release.mjs';
import { releaseArtifactContract } from './release-inputs.mjs';
import { repositoryDependencyInventory, sourceInventory } from './inventory.mjs';

export const ownerActions = Object.freeze([
  { category: 'INSTALLED_CODING_CLIENTS', action: 'Complete vendor hook trust and verify actual selected Codex/Claude surfaces in an explicitly authorized isolated checkpoint.',
    prerequisite: 'Current reviewed build and available vendor access; unavailable Claude access stays deferred.', reuse: 'Do not repeat automated lifecycle scenarios or unchanged browser capture evidence.' },
  { category: 'SIGNED_DISTRIBUTION', action: 'Authorize Developer ID/notarization and verify the signed installed custody/native chain.',
    prerequisite: 'Exact reviewed source, approved dependencies and legitimate signing inputs.', reuse: 'Reuse offline package policy, leak, provenance and recovery results.' },
  { category: 'BROWSER_DISTRIBUTION', action: 'Authorize Mozilla signing/persistent restart and Chrome Store candidate/publication steps when distribution is intended.',
    prerequisite: 'Separately approved signed artifacts and publisher accounts.', reuse: 'Reuse unchanged real-browser baseline; no repeated provider battery solely for setup changes.' },
  { category: 'PUBLICATION_DECISION', action: 'Confirm final version, license/file scope and rights, source offers, brand and private security contact before authorizing publication.',
    prerequisite: 'Independent review of exact final source, dependency/security inputs and release report.', reuse: 'Use generated inventory and public docs; no DNS, hosting, billing or funds are required for the offline gate.' },
]);

export function validateReadinessInputs(plan, { changelog, notes, browserVersions }) {
  keys(plan, ['profile', 'intent', 'version', 'sequence', 'browserVersion', 'notes']);
  if (plan.profile !== 'attestamp-release-plan/1' || plan.intent !== 'DRY_RUN_ONLY'
      || plan.notes !== 'docs/RELEASE-NOTES.md' || !/^\d+\.\d+\.\d+$/.test(plan.browserVersion)
      || !browserVersions.length || browserVersions.some(version => version !== plan.browserVersion)
      || !changelog.startsWith('# Changelog\n') || !changelog.includes(`## ${plan.version} (unreleased draft)\n`)
      || !notes.startsWith(`# ${plan.version} — unreleased draft\n`) || Buffer.byteLength(notes) > 32 * 1024) throw Error('INVALID_READINESS_INPUTS');
  const channels = ['release-candidate', 'production'].map(releaseChannel => releaseArtifactContract({ ...plan, releaseChannel }));
  return { development: { releaseChannel: 'development', releaseReady: false, signature: 'AD_HOC_ONLY', notarized: false },
    plannedChannels: channels, authority: 'NONE' };
}

export async function readinessManifest(root) {
  const plan = JSON.parse(await readFile(join(root, 'spikes/distribution/release-plan.json')));
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8'), notes = await readFile(join(root, 'docs/RELEASE-NOTES.md'), 'utf8');
  const browserVersions = await Promise.all(['shared', 'chatgpt', 'firefox'].map(async browser =>
    JSON.parse(await readFile(join(root, `spikes/browser/${browser}/extension/manifest.json`))).version));
  const channels = validateReadinessInputs(plan, { changelog, notes, browserVersions });
  const source = await sourceInventory(root), dependencies = await repositoryDependencyInventory(root);
  return { profile: 'attestamp-readiness-manifest/1', plan, ...channels, sourceDigest: source.sha256,
    repositoryDependencyDigest: sha256(canonical(dependencies)), releaseNotesDigest: sha256(notes), changelogDigest: sha256(changelog),
    ownerActionRequired: ownerActions, reusableEvidence: { baselineRevision: 'f23bae3760555c13add6ba32fdc3bcd8bbda72d8',
      boundary: 'UNCHANGED_BROWSER_CAPTURE', limits: 'New onboarding UI uses isolated regressions; no new provider or installed-client evidence is implied.' } };
}
