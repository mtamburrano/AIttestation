const secret = location.hash.slice(1) || sessionStorage.getItem('attestamp-view-token') || '';
if (/^[A-Za-z0-9_-]{43}$/.test(secret)) sessionStorage.setItem('attestamp-view-token', secret);
history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let detected = null, scope = null, selected = null, editRevision = 0, busy = false;
let previewId = null;
let diagnosticPreviewId = null;
let installationConfigured = false, releaseChannel = null, updateAvailable = false;
let capabilityUnavailable = false;
let engineState = null, selectedOperation = null, refreshSequence = 0;
let targetChosen = sessionStorage.getItem('attestamp-view-target') !== null, viewTarget = null;
try { viewTarget = JSON.parse(sessionStorage.getItem('attestamp-view-target')); } catch { targetChosen = true; }
function selectViewTarget(target) {
  targetChosen = true;
  viewTarget = target ? { tabId: target.tabId, windowId: target.windowId,
    tabEpoch: target.tabEpoch, adapterEpoch: target.adapterEpoch } : null;
  sessionStorage.setItem('attestamp-view-target', JSON.stringify(viewTarget));
}

async function api(path, data = {}) {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
}

function controls() {
  $('enroll').disabled = busy || scope !== null || detected === null;
  $('freeze').disabled = busy || capabilityUnavailable || scope === null;
  $('request').disabled = busy || !selected?.actions?.anchorRequest;
  $('cancel').disabled = busy || !selected?.actions?.cancel;
  $('confirm').disabled = busy || capabilityUnavailable || !selected?.actions?.anchor || !/^[A-Z2-7]{52}$/.test($('transaction').value);
  $('release').disabled = busy || capabilityUnavailable || !selected?.actions?.release || selected.editRevision !== editRevision;
  $('managed-anchor').disabled = busy || capabilityUnavailable || !selected?.actions?.anchor;
  for (const id of ['connect-account', 'account-status', 'disconnect-account']) $(id).disabled = busy;
  for (const id of ['refresh-history', 'preview-export', 'redact']) $(id).disabled = busy;
  $('save-export').disabled = busy || previewId === null;
  for (const id of ['enable-integration', 'open-store', 'offer-export', 'remove-integration']) {
    $(id).disabled = busy || !installationConfigured;
  }
  for (const id of ['refresh-diagnostics', 'preview-diagnostics']) $(id).disabled = busy;
  $('save-diagnostics').disabled = busy || diagnosticPreviewId === null;
  const updatesConfigured = installationConfigured && releaseChannel === 'production';
  $('check-update').disabled = busy || !updatesConfigured;
  $('download-update').disabled = busy || !updatesConfigured || !updateAvailable;
}

async function installationStatus() {
  const result = await api('/installation/status');
  installationConfigured = result.integration !== 'NOT_CONFIGURED'; releaseChannel = result.releaseChannel ?? null;
  $('release-channel').textContent = releaseChannel === 'release-candidate'
    ? 'ATTESTAMP RELEASE CANDIDATE — signed and notarized for pre-publication review only. This is not a production release; stable updates are disabled.'
    : releaseChannel === 'production'
      ? 'PRODUCTION RELEASE — signed distribution for the verified Chrome Web Store listing.'
      : 'DEVELOPMENT BUILD — no signed distribution is configured.';
  $('installation-state').textContent = {
    NOT_CONFIGURED: 'Consumer signing and Chrome Web Store distribution are not configured in this development build.',
    ENABLED: 'Local Chrome connection enabled. Add the store extension, then pair one supported tab.',
    DISABLED: 'Local Chrome connection is disabled.',
    CONFLICT: 'An existing connection file could not be recognized. It has been left untouched.',
  }[result.integration];
}
action('enable-integration', async () => { await api('/installation/enable'); await installationStatus(); });
action('open-store', async () => { await api('/installation/store'); });
action('offer-export', async () => {
  await api('/installation/export-opportunity'); $('removal-options').hidden = false;
});
action('remove-integration', async () => {
  await api('/installation/remove', { exportDecision: $('export-decision').value });
  scope = null; detected = null; selected = null; $('removal-options').hidden = true;
  $('scope').textContent = 'No scope enrolled.';
  $('pairing').textContent = 'Connection removed. Reopen the app to reconnect.';
  await installationStatus(); $('status').textContent = 'Connection removed. Evidence and keys retained on this Mac.';
});
function invalidateDiagnostics() {
  diagnosticPreviewId = null; $('diagnostic-preview').textContent = 'Selection changed. Preview before saving.'; controls();
}
$('diagnostic-operation').onchange = invalidateDiagnostics;
$('diagnostic-component').onchange = invalidateDiagnostics;
action('refresh-diagnostics', async () => {
  const selection = await api('/diagnostics/selection'), list = $('diagnostic-operation');
  list.replaceChildren(new Option('All retained operations and connection events', ''));
  for (const id of selection.operationIds) list.append(new Option(id, id));
  invalidateDiagnostics();
});
action('preview-diagnostics', async () => {
  diagnosticPreviewId = null;
  const operation = $('diagnostic-operation').value, component = $('diagnostic-component').value;
  const preview = await api('/diagnostics/preview', { operationIds: operation ? [operation] : [], components: component ? [component] : [] });
  diagnosticPreviewId = preview.previewId;
  $('diagnostic-preview').textContent = JSON.stringify(preview.report, null, 2);
});
action('save-diagnostics', async () => {
  const previewId = diagnosticPreviewId; diagnosticPreviewId = null;
  const result = await api('/diagnostics/export', { previewId });
  const url = URL.createObjectURL(new Blob([result.content], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'provenance-support.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action('check-update', async () => {
  updateAvailable = false;
  const result = await api('/installation/check-update'); updateAvailable = result.state === 'AVAILABLE';
  $('update-state').textContent = updateAvailable
    ? `Version ${result.version} is available. Its download will be verified before opening.` : 'The installed release is current.';
});
action('download-update', async () => {
  updateAvailable = false; $('update-state').textContent = 'Downloading and verifying the update…';
  const result = await api('/installation/download-update'); $('update-state').textContent = result.instruction;
});

async function receipt(value) {
  renderReceipt(value); await loadReceipts();
}
function renderReceipt(value) {
  const message = value.message ?? value.managed?.message;
  $('receipt').textContent = `${value.mode}\nState: ${value.state}\nAnchor: ${value.anchor}\nTimestamp: ${value.timestamp}\nVersion: ${value.id}\nEdit revision: ${value.editRevision}${message ? `\n${message}` : ''}`;
}

function invalidatePreview() { previewId = null; $('disclosure-preview').textContent = 'Selection changed. Preview before saving.'; controls(); }
const selectedReceipts = () => [...$('history').querySelectorAll('input:checked')].map(input => input.value);
async function loadReceipts() {
  const chosen = new Set(selectedReceipts()), history = await api('/receipts');
  $('history').replaceChildren();
  for (const group of history) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = group.id; input.checked = chosen.has(group.id);
    input.onchange = invalidatePreview; label.append(input, document.createTextNode(` ${group.title} (${group.recordIds.length} signed records)`));
    $('history').append(label);
  }
  if (!history.length) $('history').textContent = 'No local receipts yet.';
  invalidatePreview();
}
$('include-evidence').onchange = invalidatePreview;
action('refresh-history', loadReceipts);
action('preview-export', async () => {
  const preview = await api('/receipts/preview', { ids: selectedReceipts(), includeEvidence: $('include-evidence').checked });
  previewId = preview.previewId; $('disclosure-preview').textContent = JSON.stringify(preview, null, 2);
});
action('save-export', async () => {
  const result = await api('/receipts/export', { previewId });
  const url = URL.createObjectURL(new Blob([result.content], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'provenance-evidence.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('status').textContent = 'Saved the previewed selective export locally.';
});
action('redact', async () => {
  const ids = selectedReceipts(); if (ids.length !== 1) throw Error('Select exactly one receipt to derive from');
  const result = await api('/receipts/redact', { id: ids[0], text: $('redacted-text').value });
  await loadReceipts(); $('status').textContent = result.claim;
});

function action(id, operation) {
  $(id).onclick = async () => {
    if (busy) return; busy = true; controls();
    try { await operation(); } catch (error) { $('status').textContent = error.message; }
    finally { busy = false; controls(); }
  };
}

async function refresh() {
  const sequence = ++refreshSequence;
  const selectedId = selected?.id;
  const selectedWasCancelled = selected?.state === 'CANCELLED';
  const [state, engine] = await Promise.all([api('/status'), api('/engine/state').catch(() => null)]);
  if (sequence !== refreshSequence) return;
  engineState = engine;
  if (engine) {
    const list = $('target');
    list.replaceChildren(new Option('Select a target', ''));
    for (const target of engine.targets) list.append(new Option(`Window ${target.windowId}, tab ${target.tabId}: ${target.destination}`, String(target.tabId)));
    if (!targetChosen && engine.targets.length === 1) selectViewTarget(engine.targets[0]);
    const target = engine.targets.find(value => viewTarget && Object.keys(viewTarget).every(key => value[key] === viewTarget[key]));
    list.value = target ? String(target.tabId) : '';
    const enrolled = engine.scopes.find(value => value.tabId === target?.tabId && value.tabEpoch === target?.tabEpoch);
    if (scope === null && enrolled) {
      scope = enrolled.scope; editRevision = Math.max(editRevision, enrolled.editRevision);
      $('scope').textContent = `Enrolled scope: ${scope}\nDestination: ${enrolled.destination}`;
      const operation = engine.operations.filter(value => value.scope === scope).at(-1);
      if (!selected && operation) { selectedOperation = operation.id; selected = operation.result ?? null; }
    }
    if (selectedOperation) {
      const operation = engine.operations.find(value => value.id === selectedOperation);
      if (operation?.result && selected?.state !== 'CANCELLED') selected = operation.result;
    }
  }
  if (selected && selected.id === selectedId) {
    const current = state.protection.versions.find(version => version.id === selected.id);
    const becameCancelled = (current?.state === 'CANCELLED' || selected.state === 'CANCELLED') && !selectedWasCancelled;
    // A delayed status reply cannot reopen controls after this view observed cancellation.
    if (selected.state !== 'CANCELLED') selected = current ?? (engine ? selected : null);
    if (becameCancelled) {
      await receipt(selected); $('anchor').textContent = ''; $('status').textContent = selected.message;
    }
  }
  if (selected) renderReceipt(selected);
  const eligibility = state.protection.scopes?.find(value => value.scope === scope)?.eligibility ?? state.protection.eligibility;
  const modeState = engine?.scopes.find(value => value.scope === scope);
  $('engine-mode').textContent = engine?.preferences.paused ? 'Globally paused. History remains available.'
    : modeState ? `Requested mode: ${modeState.requestedMode}. Effective mode: ${modeState.effectiveMode}.`
      : 'Select an enrolled target to inspect its effective mode.';
  capabilityUnavailable = eligibility === 'TEMPORARILY_UNAVAILABLE';
  const tabs = state.browser?.tabs ?? [];
  const target = tabs.find(value => String(value.id) === $('target').value);
  detected = target?.active && target.surfaceSupported && target.composerEmpty && !target.attachmentsPresent ? target : null;
  $('pairing').textContent = detected
    ? `Detected tab ${detected.id}: ${detected.destination}`
    : 'Select an active, empty, supported ChatGPT target.';
  if (eligibility === 'REVOKED') {
    scope = null; detected = null; selected = null;
    $('scope').textContent = 'Protection eligibility revoked. Existing receipts remain available.';
    $('pairing').textContent = 'This target changed. Select and enroll its current document before starting another operation.';
  } else if (capabilityUnavailable) {
    $('pairing').textContent = 'ChatGPT is temporarily unavailable for protected sending. Return to the enrolled tab with an empty composer, then refresh.';
  }
}

$('target').onchange = () => {
  selectViewTarget(engineState?.targets.find(value => String(value.tabId) === $('target').value));
  scope = null; selected = null; selectedOperation = null; editRevision = 0;
  $('draft').value = ''; refresh().then(controls);
};

action('refresh', refresh);
action('enroll', async () => {
  if (!detected) throw Error('Refresh and select one supported tab first');
  if (!engineState) throw Error('Resident engine unavailable');
  const { eligible: _eligible, ...target } = engineState.targets.find(value => value.tabId === detected.id);
  const result = await engineCommand('ENROLL_SCOPE', { target });
  scope = result.scope; $('scope').textContent = `Enrolled scope: ${scope}\nDestination: ${target.destination}`;
  $('status').textContent = 'Scope enrolled. Compose locally and freeze one exact version.';
});

$('draft').addEventListener('input', () => {
  editRevision++;
  if (scope !== null) api('/draft', { text: $('draft').value, attachments: [], scope, editRevision })
    .catch(error => { $('status').textContent = error.message; });
  if (selected && selected.state !== 'CANCELLED' && selected.editRevision !== editRevision) $('status').textContent = 'Draft changed. The frozen version is stale; freeze a new version.';
  controls();
});
$('transaction').addEventListener('input', controls);
$('mode').addEventListener('change', () => { selected = null; controls(); });

action('freeze', async () => {
  const result = await engineCommand('DEVELOPMENT_FREEZE', { operationId: crypto.randomUUID(),
    text: $('draft').value, mode: $('mode').value, scope, editRevision });
  selectedOperation = result.operationId;
  for (;;) {
    const state = await api('/engine/state'), operation = state.operations.find(value => value.id === selectedOperation);
    if (!operation) throw Error('Operation unavailable. Refresh engine state.');
    if (operation.settled) { selected = operation.result; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!selected) throw Error('Operation needs attention. Refresh engine state.');
  await receipt(selected);
  showAnchorStatus();
});

async function engineCommand(kind, data) {
  const state = await api('/engine/state');
  return api('/engine/command', { profile: 'pap-resident-command/1', runtimeEpoch: state.runtimeEpoch,
    adapterProfile: state.adapterProfile, commandId: crypto.randomUUID(), expectedRevision: state.revision, kind, ...data });
}

function accountStatus(value) {
  const messages = {
    NOT_CONFIGURED: 'Managed anchoring is unavailable in this build.',
    ACCOUNT_REQUIRED: 'Connect your anchoring account using its access code.',
    UNPAID: 'Subscription expired. Renew your account to request new anchors.',
    RATE_LIMITED: 'Too many account requests. Retry later.',
    SERVICE_UNAVAILABLE: 'Anchoring service unavailable. Local evidence and exports remain available.',
  };
  $('account').textContent = value.state === 'ACTIVE'
    ? `Account connected. ${value.remaining} anchors remain this month. Subscription ends ${new Date(value.paidThrough).toLocaleString()}.`
    : messages[value.state] ?? 'Managed anchoring is unavailable.';
}
action('connect-account', async () => {
  const accessCode = $('access-code').value; $('access-code').value = '';
  accountStatus(await api('/managed/connect', { accessCode }));
});
action('account-status', async () => accountStatus(await api('/managed/status')));
action('disconnect-account', async () => accountStatus(await api('/managed/disconnect')));
async function anchorManaged() {
  const frozen = selected;
  selected = await api('/managed/anchor', { id: frozen.id, scope,
    currentText: frozen.mode === 'Continuous' ? undefined : $('draft').value, attachments: [], editRevision });
  await receipt(selected);
  showAnchorStatus();
}
function showAnchorStatus() {
  $('status').textContent = selected.managed?.message
    ? `${selected.managed.message} ${selected.mode === 'Continuous' ? 'Local evidence remains; anchoring is pending.' : 'Nothing has been released. Retry or cancel this version.'}`
    : selected.mode === 'Always Protect' ? `${selected.state}. Confirmed exact version was released automatically.`
      : selected.mode === 'Continuous' ? 'Local evidence now has a source-corroborated anchor.'
        : 'Exact version confirmed locally. Ready for sealed release.';
}
action('managed-anchor', anchorManaged);

action('request', async () => {
  $('anchor').textContent = JSON.stringify(await api('/anchor-request', { id: selected.id }), null, 2);
});

action('confirm', async () => {
  const frozen = selected;
  selected = await api('/confirm', { id: frozen.id, transactionId: $('transaction').value,
    scope, currentText: frozen.mode === 'Continuous' ? undefined : $('draft').value,
    attachments: [], editRevision });
  await receipt(selected);
  $('status').textContent = selected.mode === 'Always Protect'
    ? `${selected.state}. Confirmed exact version was released automatically.`
    : 'SOURCE_CORROBORATED / SOURCE_REPORTED. No stronger timestamp claim is made.';
});

action('release', async () => {
  selected = await api('/release', { id: selected.id, scope, currentText: $('draft').value,
    attachments: [], editRevision });
  await receipt(selected); $('status').textContent = `${selected.state}. Provider receipt remains unknown.`;
});

action('cancel', async () => {
  selected = await api('/cancel', { id: selected.id, scope }); await receipt(selected);
  $('anchor').textContent = ''; $('status').textContent = selected.message;
});

action('close', async () => {
  clearInterval(pairingTimer); await api('/close'); scope = null; selected = null; detected = null;
  $('status').textContent = 'View closed. Attestamp is still running. You can close this browser tab.';
});
const pairingTimer = setInterval(() => {
  if (!busy) refresh().then(controls).catch(() => {
    scope = null; selected = null; detected = null;
    $('pairing').textContent = 'Local connection unavailable. Reopen the app and pair again.'; controls();
  });
}, 2000);
addEventListener('beforeunload', () => clearInterval(pairingTimer));
Promise.all([refresh(), loadReceipts(), installationStatus(), api('/managed/status').then(accountStatus)])
  .catch(error => { $('status').textContent = error.message; }).finally(controls);
