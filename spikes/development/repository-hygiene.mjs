import { lstat, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { localGit } from '../distribution/local.mjs';
import { rejectSecretName, rejectSecretBytes } from '../distribution/package-leaks.mjs';
import { recipientSourceResources } from '../distribution/package-resources.mjs';
import { buildBrowserExtensions } from '../browser/shared/build-extensions.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function inspectRepositoryFile(path, bytes, exceptions = {}) {
  const findings = [];
  try { rejectSecretName(path); rejectSecretBytes(bytes); }
  catch (error) {
    const exception = exceptions[path];
    if (!exception || exception.sha256 !== digest(bytes) || exception.category !== error.category)
      findings.push(error.category ?? 'UNREADABLE_CONTENT');
  }
  if (path.endsWith('.md')) {
    const text = bytes.toString('utf8');
    if (/\b(?:tsk|hnd|mil|ini|doc)_[a-z0-9]{6}\b|\b(?:MVP|M|F)\d+(?:[A-Z])?-T\d|\b(?:ready_for_review|changes_requested)\b/.test(text)) findings.push('INTERNAL_BOOKKEEPING');
    if (/(?:\/Users|\/home)\/[^/\s]+\//.test(text)) findings.push('PRIVATE_HOME_PATH');
  }
  return findings;
}

export async function repositoryHygiene(directory = root) {
  const paths = [...new Set(localGit(directory, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const exceptions = JSON.parse(await readFile(join(directory, 'spikes/development/hygiene-fixtures.json')));
  const findings = [], contents = new Map();
  for (const [entry, path] of paths.entries()) {
    const info = await lstat(join(directory, path));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) { findings.push({ entry, category: 'UNSAFE_SOURCE_FILE' }); continue; }
    const bytes = await readFile(join(directory, path)); contents.set(path, bytes);
    for (const category of inspectRepositoryFile(path, bytes, exceptions)) findings.push({ entry, category });
  }
  for (const [path, exception] of Object.entries(exceptions)) {
    if (!contents.has(path) || digest(contents.get(path)) !== exception.sha256 || !exception.reason)
      findings.push({ entry: paths.indexOf(path), category: 'STALE_FIXTURE_EXCEPTION' });
  }
  const pkg = JSON.parse(contents.get('package.json'));
  for (const name of ['bootstrap', 'bootstrap:clean', 'check:hygiene', 'test:coding-acceptance'])
    if (!pkg.scripts[name]) findings.push({ entry: paths.indexOf('package.json'), category: 'MISSING_CONTRIBUTOR_COMMAND' });
  for (const path of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md', ...recipientSourceResources])
    if (!contents.has(path)) findings.push({ entry: null, category: 'MISSING_SOURCE_OR_DOCUMENT' });
  for (const [path, bytes] of contents) if (path.endsWith('.md')) {
    for (const [, target] of bytes.toString('utf8').matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const destination = target.split('#')[0];
      try { await lstat(resolve(directory, dirname(path), destination)); }
      catch { findings.push({ entry: paths.indexOf(path), category: 'BROKEN_LOCAL_DOCUMENT_LINK' }); }
    }
  }
  try { await buildBrowserExtensions({ check: true }); }
  catch { findings.push({ entry: null, category: 'GENERATED_BROWSER_DRIFT' }); }
  return { profile: 'attestamp-repository-hygiene/1', status: findings.length ? 'FAIL' : 'PASS', files: paths.length,
    reviewedSyntheticExceptions: Object.keys(exceptions).length, findings };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const report = await repositoryHygiene(); process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1; }
  catch { process.stdout.write('{"status":"FAIL","reason":"REPOSITORY_HYGIENE_UNAVAILABLE"}\n'); process.exitCode = 1; }
}
