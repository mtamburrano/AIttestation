import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectRepositoryFile } from '../spikes/development/repository-hygiene.mjs';

test('repository hygiene rejects secret, private-home and internal planning leaks without returning contents', () => {
  const cases = [
    [`${['API', 'KEY'].join('_')}=syntheticSecretValue`, 'CREDENTIAL'],
    [`/${'Users'}/fixture/private/build`, 'PRIVATE_HOME_PATH'],
    [['tsk', 'abc123'].join('_'), 'INTERNAL_BOOKKEEPING'],
  ];
  for (const [content, expected] of cases) {
    const result = inspectRepositoryFile('docs/example.md', Buffer.from(content));
    assert.ok(result.includes(expected)); assert.ok(!JSON.stringify(result).includes(content));
  }
});

test('a synthetic negative fixture exception is bound to exact bytes and category', () => {
  const bytes = Buffer.from(`${['API', 'KEY'].join('_')}=syntheticSecretValue`), path = 'test/example.mjs';
  const exceptions = { [path]: { category: 'CREDENTIAL', sha256: createHash('sha256').update(bytes).digest('hex') } };
  assert.deepEqual(inspectRepositoryFile(path, bytes, exceptions), []);
  assert.deepEqual(inspectRepositoryFile(path, Buffer.concat([bytes, Buffer.from('changed')]), exceptions), ['CREDENTIAL']);
});
