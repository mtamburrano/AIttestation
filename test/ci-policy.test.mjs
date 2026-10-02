import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('CI has read-only PR/manual boundaries, immutable actions and bounded secret-free local lanes', async () => {
  // JSON is a YAML subset, so this workflow can be parsed without a new dependency.
  const text = await readFile(new URL('../.github/workflows/deterministic.yml', import.meta.url), 'utf8');
  const workflow = JSON.parse(text), pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert.doesNotMatch(text, /secrets\.|pull_request_target|self-hosted|schedule|id-token|write-all/);
  assert.equal(workflow.jobs.macos.if, "github.event_name == 'workflow_dispatch' && inputs.macos");
  for (const [lane, job] of Object.entries(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] <= 12);
    assert.ok(['ubuntu-24.04', 'macos-15'].includes(job['runs-on']));
    assert.equal(job.steps[0].with['persist-credentials'], false);
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^actions\/(?:checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/);
      if (step.run) {
        assert.equal(step.run, `npm run ci:${lane}`);
        assert.equal(pkg.scripts[`ci:${lane}`], `node spikes/development/ci.mjs ${lane}`);
      }
      if (step.uses?.includes('upload-artifact')) {
        assert.equal(step.with.path, `artifacts/ci-${lane}/`); assert.ok(step.with['retention-days'] <= 3);
      }
    }
  }
  await access(new URL('../spikes/development/ci.mjs', import.meta.url));
});
