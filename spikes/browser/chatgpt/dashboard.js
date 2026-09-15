const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('attestamp-dashboard-token') || '';
if (/^[A-Za-z0-9_-]{43}$/.test(token)) sessionStorage.setItem('attestamp-dashboard-token', token);
const section = new URL(location.href).searchParams.get('section');
history.replaceState(null, '', '/dashboard');
if (['history', 'settings', 'integrations'].includes(section)) $(section).scrollIntoView();
let state, busy = false, closed = false, acceptedPreview = null, selectionRevision = 0, supportId = null, recovery = null, recoveryTimer, updateAvailable = false;
const selected = new Set();
const states = {
  ENGINE_UNAVAILABLE: ['Recording unavailable', 'Restart Attestamp. Retained history remains available when the vault can be opened.'],
  CONFIGURATION_CONFLICT: ['Connection needs attention', 'An existing Chrome configuration was left untouched. Check your private setup before enabling.'],
  DISABLED: ['Chrome connection disabled', 'Enable the connection below, then open the Attestamp panel in Chrome.'],
  PAUSED: ['Paused for all conversations', 'History stays available. Resume restores preferences; it never resumes an old send.'],
  DISCONNECTED: ['Chrome disconnected', 'Open or reload the Attestamp extension, then refresh. After enabling a connection, Chrome may need a restart.'],
  COVERAGE_UNAVAILABLE: ['Some conversations need attention', 'Return to the affected ChatGPT tab, check its supported text composer and reselect it in the panel.'],
  SCOPES_READY: ['Conversation inputs ready', 'Continuous records normal Send. Sealed requires the trusted panel and successful anchoring before each send.'],
  OFF: ['Capture off', 'Choose a mode for a current conversation below or in the Chrome panel.'],
  SELECT_CONVERSATION: ['Choose a conversation', 'Open the Attestamp panel in a supported ChatGPT tab and select the current conversation.'],
};
const outcomes = { PROMPT_SAVED: 'Prompt saved', SUBMISSION_OBSERVED: 'Send observed by this client',
  CANCELLED: 'Cancelled', OUTCOME_UNKNOWN: 'Delivery uncertain — do not resend automatically',
  FAILED_BEFORE_EGRESS: 'Stopped before sending', INTERRUPTED: 'Interrupted — old send authority ended',
  NEEDS_ATTENTION: 'Needs attention', ADMITTED: 'Preparing local evidence', PENDING_FAST_CONFIRMATION: 'Waiting for anchoring',
  PENDING_ANCHOR: 'Waiting for anchoring', SEALED_NOT_SENT: 'Anchored; not sent', DISPATCHING: 'Delivery uncertain' };
const anchorLabels = { PENDING: 'Anchor pending', SOURCE_CORROBORATED: 'Anchor corroborated locally', PORTABLE_PROOF: 'Portable proof retained' };
async function api(path, data = {}) {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
}
function node(tag, text, className) {
  const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; return value;
}
function controls() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy || closed;
  for (const id of ['enable', 'disable', 'prepare-remove']) $(id).disabled ||= !state?.integration.manageable;
  for (const id of ['pause', 'apply-default']) $(id).disabled ||= !state?.available;
  $('save-export').disabled ||= !acceptedPreview || !currentSelection(acceptedPreview.selection); $('save-support').disabled ||= !supportId;
  $('store').disabled ||= !state?.integration.storeAvailable;
  $('check-update').disabled ||= !state?.integration.updatesAvailable;
  $('download-update').disabled ||= !state?.integration.updatesAvailable || !updateAvailable;
  $('debug-session-toggle').disabled ||= !state?.available || !state?.debugSession || state.debugSession.state === 'UNAVAILABLE';
  $('debug-session-save').disabled ||= !state?.available || !state?.debugSession?.exportAvailable;
}
function action(id, run) {
  $(id).onclick = async () => {
    if (busy || closed) return; busy = true; controls();
    try { await run(); }
    catch { $('message').textContent = 'Action could not complete. Refresh and check the current state before trying again. Evidence has been retained.'; }
    finally { busy = false; controls(); }
  };
}
async function command(kind, data = {}) {
  if (!state) throw Error('State unavailable');
  await api('/dashboard/command', { profile: 'pap-resident-command/1', runtimeEpoch: state.runtimeEpoch,
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
  state = value;
  $('debug-session').hidden = !state.debugSession;
  $('debug-session-banner').hidden = !state.debugSession || state.debugSession.state === 'STOPPED';
  $('debug-session-banner').textContent = state.debugSession?.state === 'RECORDING'
    ? 'Private debug recording active. Save the session from Settings after testing.' : 'Private debug recording unavailable. Check Settings.';
  if (state.debugSession) {
    const debug = state.debugSession;
    $('debug-session-status').textContent = debug.state === 'UNAVAILABLE'
      ? 'Debug recording unavailable. Existing journal files need inspection; they will not be repaired automatically.'
      : `${debug.state === 'RECORDING' ? 'Debug recording active' : 'Debug recording stopped'} · ${debug.retainedEvents} retained events · ${debug.segments} segments · ${debug.droppedEvents} older events removed.`;
    $('debug-session-toggle').textContent = debug.state === 'RECORDING' ? 'Stop debug recording' : 'Start debug recording';
  }
  const [title, help] = states[state.integration.code] ?? states.ENGINE_UNAVAILABLE;
  $('effective-state').textContent = title; $('effective-help').textContent = help;
  $('pause').textContent = state.preferences.paused ? 'Resume preferences' : 'Pause all conversations';
  // Polling must not overwrite an unsaved explicit selection.
  if (document.activeElement !== $('default-mode') && !$('default-mode').dataset.edited) $('default-mode').value = state.preferences.defaultMode;
  const counts = state.history.counts;
  for (const [id, key] of [['prompt-count', 'prompts'], ['conversation-count', 'conversations'], ['anchor-count', 'pendingAnchors'], ['attention-count', 'needsAttention']]) $(id).textContent = counts[key];
  $('history-note').textContent = `${counts.unassigned} prompts have no stable conversation identity. Counts include only retained prompt submissions or admitted versions, not internal signed records.${state.history.truncated ? ' Showing the latest 200 prompts.' : ''}`;
  $('prompts').replaceChildren();
  for (const prompt of state.history.prompts) {
    const row = node('article', '', 'prompt');
    if (['OUTCOME_UNKNOWN', 'INTERRUPTED', 'NEEDS_ATTENTION', 'FAILED_BEFORE_EGRESS'].includes(prompt.state)) row.classList.add('attention');
    const title = `${prompt.mode} · ${prompt.savedAt ? new Date(prompt.savedAt).toLocaleString() : 'Preparing'} · ${prompt.conversation ?? 'Conversation not identified'}`;
    row.append(prompt.receiptId ? choice(prompt.receiptId, title) : node('h3', title));
    row.append(node('span', prompt.localSave === 'SAVED' ? 'Saved locally' : 'Local save not confirmed', 'badge'), node('span', anchorLabels[prompt.anchor], 'badge'));
    row.append(node('p', outcomes[prompt.state] ?? 'Review retained evidence for this prompt'));
    if (prompt.cancellable) {
      const cancel = node('button', 'Cancel pending send'); cancel.onclick = async () => {
        if (busy) return; busy = true; controls();
        try { await command('CANCEL_OPERATION', { operationId: prompt.operationId }); }
        catch { $('message').textContent = 'Cancellation could not be confirmed. Refresh to inspect the outcome before acting again.'; }
        finally { busy = false; controls(); }
      }; row.append(cancel);
    }
    $('prompts').append(row);
  }
  if (!state.history.prompts.length) $('prompts').textContent = 'No prompts retained yet. Choose a conversation in the Chrome panel to get started.';
  $('other-receipts').replaceChildren(...state.history.otherReceipts.map(value => choice(value.id, value.title)));
  const integration = state.integration;
  $('integration-facts').replaceChildren();
  for (const [label, text] of [['Installed', integration.installation === 'DETECTED' ? 'Extension detected through authenticated connection' : 'Not verified — installation alone does not establish coverage'],
    ['Supported', integration.supported], ['Configured', integration.configuration], ['Connected', integration.connected ? 'Yes' : 'No'],
    ['Healthy', integration.healthy ? `${integration.readyScopes} current scopes ready` : 'No active coverage confirmed']]) {
    $('integration-facts').append(node('dt', label), node('dd', text));
  }
  $('integration-help').textContent = `${integration.releaseClass ?? 'DEVELOPMENT'} · ${help} Existing Chrome settings are preserved. Removing the connection retains evidence and keys; remove the extension separately in Chrome if desired.`;
  const scopeText = scope => `Requested: ${scope.requestedMode}. Effective: ${scope.effectiveMode}.${scope.reason === 'GLOBAL_PAUSE' ? ' Global pause overrides this preference.' : ''}`;
  const existing = [...$('scopes').children];
  if (document.activeElement?.closest('#scopes') && existing.length === state.scopes.length
      && existing.every(row => state.scopes.some(scope => scope.scope === row.dataset.scope))) {
    for (const row of existing) row.querySelector('p').textContent = scopeText(state.scopes.find(scope => scope.scope === row.dataset.scope));
    return;
  }
  $('scopes').replaceChildren();
  for (const scope of state.scopes) {
    const row = node('div', '', 'scope'); row.dataset.scope = scope.scope;
    row.append(node('h3', `Window ${scope.windowId}, tab ${scope.tabId} · ${scope.destination}`), node('p', scopeText(scope)));
    const select = document.createElement('select'); select.setAttribute('aria-label', `Mode for tab ${scope.tabId}`);
    for (const mode of ['Off', 'Continuous', 'Sealed']) select.append(new Option(mode, mode)); select.value = scope.requestedMode;
    const apply = node('button', 'Apply to conversation');
    apply.onclick = async () => {
      if (busy) return; busy = true; controls();
      try { await command('SET_CONVERSATION_MODE', { scope: scope.scope, mode: select.value }); }
      catch { $('message').textContent = 'Conversation changed. Refresh and select its current scope again.'; }
      finally { busy = false; controls(); }
    }; row.append(select, apply); $('scopes').append(row);
  }
}
async function refresh() {
  try { const value = await api('/dashboard/state'); if (!closed) { render(value); controls(); } }
  catch { if (state) state.available = false; $('effective-state').textContent = 'Engine connection unavailable';
    if (state?.debugSession) {
      $('debug-session-banner').hidden = false;
      $('debug-session-banner').textContent = $('debug-session-status').textContent = 'Debug recording status unavailable. Reopen Attestamp and refresh.';
    }
    $('effective-help').textContent = 'Reopen Attestamp and refresh. No current recording or protection is confirmed.'; controls(); }
}
action('refresh', refresh);
action('pause', () => command('SET_PAUSE', { paused: !state.preferences.paused }));
$('default-mode').onchange = () => { $('default-mode').dataset.edited = 'true'; };
action('apply-default', async () => { const mode = $('default-mode').value; await command('SET_DEFAULT', { mode }); delete $('default-mode').dataset.edited; });
for (const kind of ['enable', 'disable']) action(kind, async () => {
  await api(`/installation/${kind}`); await refresh();
  $('message').textContent = kind === 'enable' ? 'Connection enabled. Reopen the Chrome panel and select a current conversation. Restart Chrome if it cannot connect.' : 'Connection disabled. Evidence, keys and preferences retained.';
});
action('prepare-remove', async () => { await api('/installation/export-opportunity'); $('removal').hidden = false; });
action('cancel-remove', async () => { $('removal').hidden = true; });
action('remove', async () => { await api('/installation/remove', { exportDecision: $('removal-choice').value }); $('removal').hidden = true; await refresh(); $('message').textContent = 'Connection removed. Evidence and keys retained on this Mac.'; });
function download(bytes, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('include-evidence').onchange = invalidatePreview;
action('preview-export', async () => {
  invalidatePreview();
  const selection = Object.freeze({ revision: selectionRevision, ids: Object.freeze([...selected]), includeEvidence: $('include-evidence').checked });
  const preview = await api('/receipts/preview', { ids: selection.ids, includeEvidence: selection.includeEvidence });
  if (!currentSelection(selection)) return;
  acceptedPreview = Object.freeze({ previewId: preview.previewId, selection });
  $('preview').hidden = false; $('disclosure-notice').textContent = preview.disclosureNotice;
  $('preview-texts').replaceChildren(...preview.texts.map(value => node('pre', value.preview ?? 'Exact bytes excluded')));
  $('preview-summary').textContent = `${selection.ids.length} selected receipts. ${preview.evidenceObjects} evidence objects; ${preview.publicProofObjects} portable proof objects. ${preview.exportBytes} bytes. Signed metadata and links are included.`;
  $('preview-details').textContent = JSON.stringify(preview, null, 2);
});
action('save-export', async () => {
  const preview = acceptedPreview;
  if (!preview || !currentSelection(preview.selection)) { invalidatePreview(); return; }
  const result = await api('/receipts/export', { previewId: preview.previewId });
  if (acceptedPreview !== preview || !currentSelection(preview.selection)) return;
  download(result.content, 'attestamp-evidence.json'); $('message').textContent = 'Reviewed evidence export saved.';
});
action('verifier', () => api('/dashboard/verifier'));
action('store', () => api('/installation/store'));
action('check-update', async () => {
  updateAvailable = false; const result = await api('/installation/check-update'); updateAvailable = result.state === 'AVAILABLE';
  $('update-state').textContent = updateAvailable ? 'An update is available. Download it to verify its signature and bytes before installation.' : 'The installed release is current.';
});
action('download-update', async () => { updateAvailable = false; const result = await api('/installation/download-update'); $('update-state').textContent = result.instruction; });
function account(value) {
  $('account').textContent = value.state === 'ACTIVE' ? 'Anchoring account connected. Availability is checked for each new protected send.'
    : 'Anchoring unavailable. Connect or renew your account, or retry after the service recovers. Sealed will wait or cancel; local history, recovery and export stay available.';
}
action('refresh-account', async () => account(await api('/managed/status')));
action('connect-account', async () => { const accessCode = $('access-code').value; $('access-code').value = ''; account(await api('/managed/connect', { accessCode })); });
action('disconnect-account', async () => account(await api('/managed/disconnect')));
function clearRecovery() { recovery = null; clearTimeout(recoveryTimer); $('recovery').hidden = true; $('recovery-consent').checked = false; }
action('prepare-recovery', async () => {
  if (!$('recovery-consent').checked) { $('message').textContent = 'Confirm separate private storage for the recovery key first.'; return; }
  clearRecovery(); recovery = await api('/dashboard/recovery', { confirmed: true }); $('recovery').hidden = false;
  recoveryTimer = setTimeout(clearRecovery, 60000);
});
action('save-recovery', async () => download(recovery.package, 'attestamp-encrypted-recovery.json'));
action('save-recovery-key', async () => download(Uint8Array.from(atob(recovery.recoveryKey), value => value.charCodeAt(0)), 'attestamp-recovery.key', 'application/octet-stream'));
action('clear-recovery', async () => clearRecovery());
action('preview-support', async () => { supportId = null; const preview = await api('/diagnostics/preview', { operationIds: [], components: [] }); supportId = preview.previewId; $('support').textContent = JSON.stringify(preview.report, null, 2); });
action('save-support', async () => { const result = await api('/diagnostics/export', { previewId: supportId }); download(result.content, 'attestamp-support.json'); });
action('debug-session-toggle', async () => {
  try { await api('/debug-session/recording', { enabled: state.debugSession.state !== 'RECORDING' }); }
  finally { await refresh(); }
});
action('debug-session-save', async () => {
  try {
    const result = await api('/debug-session/export'); download(result.content, 'attestamp-debug-session.json');
    $('message').textContent = 'Private debug session saved. Attach this file after testing when you choose to share it.';
  } finally { await refresh(); }
});
action('development', async () => { location.href = `/#${token}`; });
action('close', async () => {
  await api('/close'); closed = true; clearInterval(timer); invalidatePreview(); clearRecovery();
  $('message').textContent = 'Dashboard closed. Attestamp is still running. You can close this browser tab.';
});
const timer = setInterval(() => { if (!busy && !closed) void refresh(); }, 2000);
addEventListener('beforeunload', () => { closed = true; clearInterval(timer); invalidatePreview(); clearRecovery(); });
void refresh();
