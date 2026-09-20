const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('attestamp-dashboard-token') || '';
if (/^[A-Za-z0-9_-]{43}$/.test(token)) sessionStorage.setItem('attestamp-dashboard-token', token);
const section = new URL(location.href).searchParams.get('section');
history.replaceState(null, '', '/dashboard');
if (['history', 'settings', 'integrations'].includes(section)) $(section).scrollIntoView();
let state, busy = false, closed = false, acceptedPreview = null, selectionRevision = 0, supportId = null, recovery = null, recoveryTimer, updateAvailable = false;
const selected = new Set();
let attentionOnly = false, historyOffset = 0, actionFeedback = null;
let acknowledgedDebugSession = null;
const states = {
  ENGINE_UNAVAILABLE: ['Recording unavailable', 'Restart Attestamp. Retained history remains available when the vault can be opened.'],
  CONFIGURATION_CONFLICT: ['Connection needs attention', 'An existing Chrome configuration was left untouched. Check your private setup before enabling.'],
  DISABLED: ['Chrome connection disabled', 'Enable the connection below, then open the Attestamp panel in Chrome.'],
  DISCONNECTED: ['Chrome disconnected', 'Open or reload the Attestamp extension, then refresh. After enabling a connection, Chrome may need a restart.'],
  COVERAGE_UNAVAILABLE: ['Some conversations need attention', 'Check the supported text composer in the affected ChatGPT tab. Recording gaps do not stop your Send.'],
  SOURCES_READY: ['ON · Supported tabs ready', 'Normal Send observations are recorded automatically. Look for Prompt saved after each supported Send.'],
  OFF: ['Attestamp is OFF', 'New capture is stopped. Saved evidence and bounded pending anchoring remain available.'],
  WAITING_FOR_TABS: ['ON · Waiting for supported tabs', 'Open ChatGPT in normal Chrome. Existing and new supported tabs are followed automatically.'],
};
const outcomes = { PROMPT_SAVED: 'Prompt saved', SUBMISSION_OBSERVED: 'Send observed by this client',
  CANCELLED: 'Cancelled', OUTCOME_UNKNOWN: 'Delivery uncertain — do not resend automatically',
  FAILED_BEFORE_EGRESS: 'Stopped before sending', INTERRUPTED: 'Interrupted — old send authority ended',
  NEEDS_ATTENTION: 'Needs attention' };
const anchorLabels = { PENDING: 'Anchor pending', SOURCE_CORROBORATED: 'Anchor corroborated locally', PORTABLE_PROOF: 'Portable proof retained' };
async function api(path, data = {}) {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
}
function node(tag, text, className) {
  const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; return value;
}
function currentDebugAcknowledgment(debug = state?.debugSession) {
  return debug?.state === 'STOPPED' && acknowledgedDebugSession?.sessionId === debug.sessionId
    && acknowledgedDebugSession?.revision === debug.revision;
}
function controls() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy || closed;
  for (const id of ['enable', 'disable', 'prepare-remove']) $(id).disabled ||= !state?.integration.manageable;
  for (const id of ['recording']) $(id).disabled ||= !state?.available;
  $('save-export').disabled ||= !acceptedPreview || !currentSelection(acceptedPreview.selection); $('save-support').disabled ||= !supportId;
  $('store').disabled ||= !state?.integration.storeAvailable;
  $('check-update').disabled ||= !state?.integration.updatesAvailable;
  $('download-update').disabled ||= !state?.integration.updatesAvailable || !updateAvailable;
  $('debug-session-toggle').disabled ||= !state?.available || !state?.debugSession || state.debugSession.state === 'UNAVAILABLE';
  $('debug-session-save').disabled ||= !state?.available || !state?.debugSession?.exportAvailable;
  const canStartFresh = state?.available && state?.debugSession?.state === 'STOPPED' && state.debugSession.sessionId;
  $('debug-session-acknowledge').disabled = busy || closed || !canStartFresh;
  $('debug-session-new').disabled ||= !canStartFresh || !currentDebugAcknowledgment();
}
function action(id, run) {
  $(id).onclick = async () => {
    if (busy || closed) return; busy = true; controls();
    for (const previous of document.querySelectorAll('.action-feedback')) previous.hidden = true;
    let feedback = $(`feedback-${id}`);
    if (!feedback) {
      feedback = node('p', '', 'action-feedback'); feedback.id = `feedback-${id}`;
      feedback.setAttribute('role', 'status'); feedback.tabIndex = -1;
      ($(id).closest('.actions') ?? $(id)).after(feedback);
    }
    actionFeedback = feedback; feedback.hidden = false; feedback.textContent = 'Working…';
    try { await run(); if (feedback.textContent === 'Working…') feedback.textContent = 'Done.'; }
    catch { notify('Action could not complete. Refresh and check the current state before trying again. Evidence has been retained.'); }
    finally {
      busy = false; controls(); actionFeedback = null;
      const hidden = feedback.closest('[hidden]');
      if (hidden) hidden.after(feedback);
      const bounds = feedback.getBoundingClientRect();
      if (bounds.top < 0 || bounds.bottom > innerHeight) feedback.scrollIntoView({ block: 'nearest' });
      feedback.focus({ preventScroll: true });
    }
  };
}
function notify(text) {
  $('message').textContent = text;
  if (actionFeedback) actionFeedback.textContent = text;
}
async function command(kind, data = {}) {
  if (!state) throw Error('State unavailable');
  await api('/dashboard/command', { profile: 'pap-resident-command/2', runtimeEpoch: state.runtimeEpoch,
    expectedRevision: state.revision, adapterProfile: state.adapterProfile, commandId: crypto.randomUUID(), kind, ...data });
  await refresh();
}
function currentSelection(selection) {
  return !closed && selection.revision === selectionRevision
    && selection.includeEvidence === $('include-evidence').checked
    && selection.ids.length === selected.size && selection.ids.every(id => selected.has(id));
}
function invalidatePreview() {
  // Changing back to the original controls must not revive an outstanding request.
  selectionRevision++; acceptedPreview = null; $('preview').hidden = true;
  for (const id of ['disclosure-notice', 'preview-texts', 'preview-summary', 'preview-details']) $(id).replaceChildren();
  controls();
}
function choice(id, text) {
  const label = node('label', ''), input = document.createElement('input'); input.type = 'checkbox'; input.value = id; input.checked = selected.has(id);
  input.onchange = () => { if (input.checked) selected.add(id); else selected.delete(id); invalidatePreview(); };
  label.append(input, document.createTextNode(text)); return label;
}
function render(value) {
  if (!currentDebugAcknowledgment(value.debugSession)) {
    acknowledgedDebugSession = null; $('debug-session-acknowledge').checked = false;
  }
  state = value;
  $('release-channel').textContent = state.integration.releaseClass === 'RELEASE_CANDIDATE'
    ? 'ATTESTAMP RELEASE CANDIDATE — PRE-PUBLICATION REVIEW ONLY. Stable updates are disabled.'
    : state.integration.releaseClass === 'PRODUCTION' ? 'Production release' : 'Private development build';
  $('debug-session').hidden = !state.debugSession;
  $('debug-session-banner').hidden = !state.debugSession || state.debugSession.state === 'STOPPED';
  $('debug-session-banner').textContent = state.debugSession?.state === 'RECORDING'
    ? 'Private debug recording active. Save the session from Settings after testing.' : 'Private debug recording unavailable. Check Settings.';
  if (state.debugSession) {
    const debug = state.debugSession;
    $('debug-session-status').textContent = debug.state === 'UNAVAILABLE'
      ? 'Debug recording unavailable. Existing journal files need inspection; they will not be repaired automatically.'
      : `${debug.state === 'RECORDING' ? 'Debug recording active' : debug.sessionId ? 'Debug recording paused' : 'Debug recording not started'} · ${debug.retainedEvents} retained events · ${debug.segments} segments · ${debug.droppedEvents} older events removed.`;
    $('debug-session-toggle').textContent = debug.state === 'RECORDING' ? 'Pause debug recording'
      : debug.sessionId ? 'Resume debug recording' : 'Start debug recording';
  }
  const [title, help] = states[state.integration.code] ?? states.ENGINE_UNAVAILABLE;
  $('effective-state').textContent = title; $('effective-help').textContent = help;
  $('recording').textContent = state.recording ? 'Turn OFF' : 'Turn ON';
  const counts = state.history.counts;
  for (const [id, key] of [['prompt-count', 'prompts'], ['conversation-count', 'conversations'], ['anchor-count', 'pendingAnchors'], ['attention-count', 'needsAttention']]) $(id).textContent = counts[key];
  $('history-note').textContent = `${counts.unassigned} prompts have no stable conversation identity. Counts include only retained observations and historical evidence, not complete provider history.`;
  const page = state.history.page;
  historyOffset = page.offset;
  $('filter-attention').setAttribute('aria-pressed', String(attentionOnly));
  $('all-prompts').hidden = !attentionOnly;
  $('history-filter').textContent = `${attentionOnly ? 'Needs attention' : 'All prompts'} · ${page.total ? `${page.offset + 1}–${Math.min(page.offset + 200, page.total)} of ${page.total}` : 'No matching prompts'}. Pending anchors are counted separately.`;
  $('history-newer').hidden = page.offset === 0;
  $('history-older').hidden = page.offset + 200 >= page.total;
  $('prompts').replaceChildren();
  for (const prompt of state.history.prompts) {
    const row = node('article', '', 'prompt');
    if (prompt.attention) row.classList.add('attention');
    const title = `${prompt.mode} · ${prompt.savedAt ? new Date(prompt.savedAt).toLocaleString() : 'Preparing'} · ${prompt.conversation ?? 'Conversation not identified'}`;
    row.append(prompt.receiptId ? choice(prompt.receiptId, title) : node('h3', title));
    row.append(node('span', prompt.localSave === 'SAVED' ? 'Saved locally' : 'Local save not confirmed', 'badge'), node('span', anchorLabels[prompt.anchor], 'badge'));
    row.append(node('p', outcomes[prompt.state] ?? 'Review retained evidence for this prompt'));
    if (prompt.attention) {
      row.append(node('strong', 'Needs attention'), node('p', prompt.attention.reason), node('p', prompt.attention.nextAction));
    }
    $('prompts').append(row);
  }
  if (!state.history.prompts.length) $('prompts').textContent = attentionOnly ? 'No retained prompts need attention.' : 'No prompts retained yet. Turn ON and use normal Send in a supported ChatGPT tab.';
  $('other-receipts').replaceChildren(...state.history.otherReceipts.map(value => choice(value.id, value.title)));
  const integration = state.integration;
  $('integration-facts').replaceChildren();
  for (const [label, text] of [['Installed', integration.installation === 'DETECTED' ? 'Extension detected through authenticated connection' : 'Not verified — installation alone does not establish coverage'],
    ['Supported', integration.supported], ['Configured', integration.configuration], ['Connected', integration.connected ? 'Yes' : 'No'],
    ['Healthy', integration.healthy ? `${integration.readySources} supported tabs ready` : 'No active coverage confirmed']]) {
    $('integration-facts').append(node('dt', label), node('dd', text));
  }
  $('integration-help').textContent = `${integration.releaseClass ?? 'DEVELOPMENT'} · ${help} Existing Chrome settings are preserved. Removing the connection retains evidence and keys; remove the extension separately in Chrome if desired.`;

}
async function refresh() {
  try { const value = await api('/dashboard/state', { attentionOnly, offset: historyOffset }); if (!closed) { render(value); controls(); } }
  catch { if (state) state.available = false; $('effective-state').textContent = 'Engine connection unavailable';
    if (actionFeedback) notify('Status unavailable. Reopen Attestamp and refresh. Current recording is not confirmed.');
    if (state?.debugSession) {
      $('debug-session-banner').hidden = false;
      $('debug-session-banner').textContent = $('debug-session-status').textContent = 'Debug recording status unavailable. Reopen Attestamp and refresh.';
    }
    $('effective-help').textContent = 'Reopen Attestamp and refresh. Current recording is not confirmed.'; controls(); }
}
action('refresh', refresh);
action('filter-attention', async () => { attentionOnly = !attentionOnly; historyOffset = 0; await refresh(); });
action('all-prompts', async () => { attentionOnly = false; historyOffset = 0; await refresh(); });
action('history-newer', async () => { historyOffset = Math.max(0, historyOffset - 200); await refresh(); });
action('history-older', async () => { historyOffset += 200; await refresh(); });
action('recording', () => command('SET_RECORDING', { enabled: !state.recording }));
for (const kind of ['enable', 'disable']) action(kind, async () => {
  await api(`/installation/${kind}`); await refresh();
  notify(kind === 'enable' ? 'Connection enabled. Open supported ChatGPT tabs. Restart Chrome if it cannot connect.' : 'Connection disabled. Evidence, keys and preferences retained.');
});
action('prepare-remove', async () => { await api('/installation/export-opportunity'); $('removal').hidden = false; });
action('cancel-remove', async () => { $('removal').hidden = true; });
action('remove', async () => { await api('/installation/remove', { exportDecision: $('removal-choice').value }); $('removal').hidden = true; await refresh(); notify('Connection removed. Evidence and keys retained on this Mac.'); });
function download(bytes, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('include-evidence').onchange = invalidatePreview;
action('preview-export', async () => {
  invalidatePreview();
  const selection = Object.freeze({ revision: selectionRevision, ids: Object.freeze([...selected]), includeEvidence: $('include-evidence').checked });
  const preview = await api('/receipts/preview', { ids: selection.ids, includeEvidence: selection.includeEvidence });
  if (!currentSelection(selection)) { notify('Selection changed. Review the selected evidence again before saving.'); return; }
  acceptedPreview = Object.freeze({ previewId: preview.previewId, selection });
  $('preview').hidden = false; $('disclosure-notice').textContent = preview.disclosureNotice;
  $('preview-texts').replaceChildren(...preview.texts.map(value => node('pre', value.preview ?? 'Exact bytes excluded')));
  $('preview-summary').textContent = `${selection.ids.length} selected receipts. ${preview.evidenceObjects} evidence objects; ${preview.publicProofObjects} portable proof objects. ${preview.exportBytes} bytes. Signed metadata and links are included.`;
  $('preview-details').textContent = JSON.stringify(preview, null, 2);
});
action('save-export', async () => {
  const preview = acceptedPreview;
  if (!preview || !currentSelection(preview.selection)) { invalidatePreview(); notify('Review the current selection before saving.'); return; }
  const result = await api('/receipts/export', { previewId: preview.previewId });
  if (acceptedPreview !== preview || !currentSelection(preview.selection)) { notify('Selection changed. Review the selected evidence again before saving.'); return; }
  download(result.content, 'attestamp-evidence.json'); notify('Reviewed evidence export saved.');
});
action('verifier', () => api('/dashboard/verifier'));
action('store', () => api('/installation/store'));
action('check-update', async () => {
  updateAvailable = false; const result = await api('/installation/check-update'); updateAvailable = result.state === 'AVAILABLE';
  $('update-state').textContent = updateAvailable ? 'An update is available. Download it to verify its signature and bytes before installation.' : 'The installed release is current.';
});
action('download-update', async () => { updateAvailable = false; const result = await api('/installation/download-update'); $('update-state').textContent = result.instruction; });
function account(value) {
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month ?? '') ? value.month : null;
  const remaining = Number.isSafeInteger(value.remaining) && value.remaining >= 0 && value.remaining <= 1000 ? value.remaining : null;
  const status = value.state === 'ACTIVE' && remaining === 0 ? 'QUOTA_EXHAUSTED' : value.state;
  const labels = {
    ACTIVE: `Anchoring account active. ${remaining === null ? 'Remaining quota unavailable.' : `${remaining} anchors remaining.`} ${period ? `Period: ${period}.` : 'Period unavailable.'}`,
    ACCOUNT_REQUIRED: 'No anchoring account connected. Enter your access code to connect.',
    UNPAID: 'Anchoring account unpaid or expired. Renew your account to request new anchors.',
    QUOTA_EXHAUSTED: `Anchoring quota exhausted.${period ? ` Period: ${period}.` : ''} Wait for the next quota period before requesting new anchors.`,
    SERVICE_UNAVAILABLE: 'Anchoring service unavailable. Refresh account later to check availability.',
  };
  $('account').textContent = Object.hasOwn(labels, status) ? labels[status] : labels.SERVICE_UNAVAILABLE;
  notify($('account').textContent);
}
async function accountAction(path, data) {
  try { account(await api(path, data)); }
  catch { account({ state: 'SERVICE_UNAVAILABLE' }); }
}
action('refresh-account', () => accountAction('/managed/status'));
action('connect-account', async () => { const accessCode = $('access-code').value; $('access-code').value = ''; await accountAction('/managed/connect', { accessCode }); });
action('disconnect-account', () => accountAction('/managed/disconnect'));
function clearRecovery() { recovery = null; clearTimeout(recoveryTimer); $('recovery').hidden = true; $('recovery-consent').checked = false; }
action('prepare-recovery', async () => {
  if (!$('recovery-consent').checked) { notify('Confirm separate private storage for the recovery key first.'); return; }
  clearRecovery(); recovery = await api('/dashboard/recovery', { confirmed: true }); $('recovery').hidden = false;
  recoveryTimer = setTimeout(clearRecovery, 60000);
});
action('save-recovery', async () => download(recovery.package, 'attestamp-encrypted-recovery.json'));
action('save-recovery-key', async () => download(Uint8Array.from(atob(recovery.recoveryKey), value => value.charCodeAt(0)), 'attestamp-recovery.key', 'application/octet-stream'));
action('clear-recovery', async () => clearRecovery());
action('preview-support', async () => { supportId = null; const preview = await api('/diagnostics/preview', { operationIds: [], components: [] }); supportId = preview.previewId; $('support').textContent = JSON.stringify(preview.report, null, 2); });
action('save-support', async () => { const result = await api('/diagnostics/export', { previewId: supportId }); download(result.content, 'attestamp-support.json'); });
action('debug-session-toggle', async () => {
  acknowledgedDebugSession = null; $('debug-session-acknowledge').checked = false;
  try { await api('/debug-session/recording', { enabled: state.debugSession.state !== 'RECORDING' }); }
  finally { await refresh(); }
});
action('debug-session-save', async () => {
  try {
    const result = await api('/debug-session/export'); download(result.content, 'attestamp-debug-session.json');
    notify('Private debug session saved. Attach this file after testing when you choose to share it.');
  } finally { await refresh(); }
});
$('debug-session-acknowledge').onchange = () => {
  acknowledgedDebugSession = $('debug-session-acknowledge').checked && state?.debugSession?.state === 'STOPPED'
    ? { sessionId: state.debugSession.sessionId, revision: state.debugSession.revision } : null;
  controls();
};
action('debug-session-new', async () => {
  if (!currentDebugAcknowledgment()) {
    notify('Pause debug recording and acknowledge the current session first.'); return;
  }
  const request = { ...acknowledgedDebugSession, acknowledged: true };
  acknowledgedDebugSession = null; $('debug-session-acknowledge').checked = false;
  try {
    await api('/debug-session/new', request);
    notify('Fresh debug session created with no retained events. Resume debug recording when ready.');
  } catch (error) { notify(error.message); }
  finally { await refresh(); }
});
action('close', async () => {
  await api('/close'); closed = true; clearInterval(timer); invalidatePreview(); clearRecovery();
  notify('Dashboard closed. Attestamp is still running. You can close this browser tab.');
});
const timer = setInterval(() => { if (!busy && !closed) void refresh(); }, 2000);
addEventListener('beforeunload', () => { closed = true; clearInterval(timer); invalidatePreview(); clearRecovery(); });
void refresh();
