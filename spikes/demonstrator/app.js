const key = location.hash.slice(1); history.replaceState(null, '', '/');
const $ = id => document.getElementById(id), scope = crypto.randomUUID();
let selected = null, generation = 0, enrolled = false, policy, providerOrigin, recovery, restoredBundle, busy = false;
async function api(path, data = {}) {
  const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(data) });
  const value = await r.json(); if (!r.ok) throw Error(value.error); return value;
}
async function fileText(id, optional = false) {
  const file = $(id).files[0]; if (!file) { if (optional) return null; throw Error(`Choose a file: ${$(id).parentElement.textContent.trim()}`); }
  if (file.size > 16 * 1024 * 1024) throw Error('Import limit: 16 MiB'); return file.text();
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function payload() {
  const text = $('draft').value, files = [...$('files').files];
  if (files.length > 4) throw Error('Select up to four attachments');
  const attachments = await Promise.all(files.map(async f => {
    if (f.size > 100000) throw Error('Attachment limit: 100 KB');
    return { name: f.name, bytes: btoa(Array.from(new Uint8Array(await f.arrayBuffer()), b => String.fromCharCode(b)).join('')) };
  })); return { text, attachments };
}
function controls() {
  $('freeze').disabled = !enrolled || busy;
  $('confirm').disabled = busy || !selected || selected.anchor !== 'PENDING';
  $('release').disabled = busy || !selected || !!selected.attempt || (selected.mode !== 'Continuous' && selected.anchor === 'PENDING');
  $('request').disabled = busy || !selected;
}
function receipt(v) {
  const states = { PENDING_ANCHOR: 'Waiting for anchor proof. This version has not been sent.',
    SEALED_NOT_SENT: 'Confirmed and sealed, not sent.', SUBMISSION_OBSERVED: 'Local submission observed.',
    OUTCOME_UNKNOWN: 'The send outcome is unknown. No automatic resend.', FAILED_BEFORE_EGRESS: 'Release failed before sending.' };
  $('receipt').textContent = `${v.mode}\n${states[v.state] ?? v.state}\n\nAnchor: ${v.anchor}\n` +
    `Release attempt: ${v.attempt ? v.attempt.attemptId : 'None'}\n` +
    `Visible response: ${v.response ? 'Captured exact displayed text bytes' : 'Not captured'}\n` +
    `Provider receipt: Unknown\nVersion: ${v.id}\n\n` +
    (policy === 'fixture' ? 'Synthetic log signature only. No public-chain or UTC-time assurance.' : 'Trust is limited to the independently selected Algorand checkpoint.');
}
function invalidate() { generation++; selected = null; controls(); $('status').textContent = 'Draft or path changed locally. Freeze a new version.'; }
for (const id of ['draft', 'files', 'mode', 'supported']) $(id).addEventListener(id === 'draft' ? 'input' : 'change', invalidate);
function action(id, fn) {
  $(id).onclick = async () => {
    if (busy) return; busy = true; controls();
    try { await fn(); } catch (e) { $('status').textContent = e.message; }
    finally { busy = false; controls(); }
  };
}
async function release() {
  const v = selected, version = generation, currentPayload = await payload();
  if (!v || version !== generation || selected !== v) throw Error('Draft changed');
  const result = await api('/release', { id: v.id, scope, currentPayload, supported: $('supported').checked });
  if (selected === v) selected = result;
  receipt(result); $('status').textContent = `${result.state}. Provider receipt remains unknown.`;
  $('provider').src = result.providerURL;
}
async function confirm() {
  const v = selected, version = generation;
  if (!v) throw Error('Freeze a version first');
  const proof = await fileText('proof', policy === 'fixture');
  const result = await api('/confirm', { id: v.id, proof });
  if (selected !== v || version !== generation) { $('status').textContent = 'Older version confirmed but not sent. Freeze the edited draft.'; return; }
  selected = result; receipt(result);
  $('status').textContent = result.attempt ? 'Continuous evidence confirmed after release.' : 'SEALED_NOT_SENT. Exact version confirmed; nothing released.';
  if (selected.mode === 'Always Protect') await release();
}
action('start', async () => {
  if (!$('enrollment').checked) throw Error('Explicit scope enrollment is required');
  policy = $('policy').value;
  const trustText = await fileText('trust', true);
  const result = await api('/enroll', { scope, policy, trust: trustText ? JSON.parse(trustText) : null });
  enrolled = true; providerOrigin = result.providerOrigin;
  $('scope').textContent = `Enrolled scope: this local session → synthetic loopback provider. ${result.assurance}`;
  $('provider').src = providerOrigin; $('start').disabled = true; $('policy').disabled = true; $('trust').disabled = true;
  $('status').textContent = 'Local session ready. Type synthetic text and select a small attachment.';
});
action('freeze', async () => {
  const version = generation;
  const data = { scope, mode: $('mode').value, supported: $('supported').checked, payload: await payload() };
  if (version !== generation) throw Error('Draft changed');
  const v = await api('/freeze', data);
  if (version !== generation) { $('status').textContent = 'Older version frozen. Freeze the edited draft.'; return; }
  selected = v; receipt(v); $('status').textContent = 'PENDING_ANCHOR. Frozen and encrypted locally; nothing released.';
  if (v.mode === 'Continuous') await release();
  else if (v.mode === 'Always Protect' && policy === 'fixture') await confirm();
});
action('confirm', confirm); action('release', release);
action('request', async () => download('anchor-request.json', JSON.stringify(await api('/anchor-request', { id: selected.id }))));
window.addEventListener('message', async e => {
  if (e.origin !== providerOrigin || e.source !== $('provider').contentWindow || e.data?.kind !== 'synthetic-visible'
      || e.data.attemptId !== selected?.attempt?.attemptId) return;
  const v = selected;
  try { const result = await api('/capture', { id: v.id, scope, text: e.data.text });
    if (selected === v) { selected = result; receipt(result); $('status').textContent = 'Submission observed and visible response captured locally. Provider receipt remains unknown.'; }
  } catch (error) { $('status').textContent = error.message; }
});
action('export', async () => {
  const result = await api('/export');
  // Trust is deliberately a separate download and must be selected explicitly by a verifier.
  const { trust, ...bundle } = result;
  download('evidence-export.json', JSON.stringify(bundle));
  $('status').textContent = 'Plaintext evidence exported. Save the separate trust configuration for fixture rehearsal only; independently choose real trust roots.';
  if (trust) { $('verification').textContent = JSON.stringify(trust, null, 2); }
});
action('backup', async () => {
  recovery = await api('/recovery'); download('encrypted-recovery.json', recovery.package); $('secret').disabled = false;
  $('status').textContent = 'Encrypted snapshot saved. Save its separate recovery secret before closing.';
});
action('secret', async () => download('separate-recovery-secret.txt', recovery.recoveryKey));
action('restore', async () => {
  const result = await api('/restore', { package: await fileText('recoveryPackage'), recoveryKey: (await fileText('recoverySecret')).trim() });
  const { disclosure, bundle, ...report } = result; restoredBundle = bundle; $('saveRestored').disabled = false;
  $('recoveryStatus').textContent = JSON.stringify(report, null, 2);
  $('status').textContent = 'Restored and verified in a fresh vault with new local keys. No send authorization restored.';
});
action('saveRestored', async () => download('restored-evidence-export.json', JSON.stringify(restoredBundle)));
action('verify', async () => {
  const report = await api('/verify', { bundle: JSON.parse(await fileText('verifyExport')), trust: JSON.parse(await fileText('verifyTrust')) });
  $('verification').textContent = JSON.stringify(report, null, 2); $('status').textContent = report.valid ? 'Local verification finished. Read each assurance dimension.' : 'Verification failed or is incomplete.';
});
action('saveTrust', async () => {
  const { trust } = await api('/export'); if (!trust) throw Error('No trust configuration selected');
  download('separate-trust.json', JSON.stringify(trust));
  $('status').textContent = 'Trust saved separately. This copy documents session trust; it is not independently authenticated by the export.';
});
action('close', async () => { await api('/close'); enrolled = false; $('status').textContent = 'Local runtime closed. Reopening starts a fresh session; use your recovery package and separate secret.'; });
api('/ready').catch(error => { $('status').textContent = `Local connection unavailable: ${error.message}`; });
