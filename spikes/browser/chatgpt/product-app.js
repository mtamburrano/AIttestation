const secret = location.hash.slice(1); history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let detected = null, scope = null, selected = null, editRevision = 0, busy = false;
let previewId = null;
let installationConfigured = false, releaseChannel = null, updateAvailable = false;

async function api(path, data = {}) {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
}

function controls() {
  $('enroll').disabled = busy || scope !== null || detected === null;
  $('freeze').disabled = busy || scope === null;
  $('request').disabled = busy || selected === null;
  $('cancel').disabled = busy || selected === null || selected.anchor !== 'PENDING' || selected.attempt !== null;
  $('confirm').disabled = busy || selected === null || selected.anchor !== 'PENDING' || !/^[A-Z2-7]{52}$/.test($('transaction').value);
  $('release').disabled = busy || selected === null || selected.mode !== 'Sealed'
    || selected.state !== 'SEALED_NOT_SENT' || selected.editRevision !== editRevision;
  $('managed-anchor').disabled = busy || selected === null || selected.anchor !== 'PENDING' || selected.state === 'CANCELLED';
  for (const id of ['connect-account', 'account-status', 'disconnect-account']) $(id).disabled = busy;
  for (const id of ['refresh-history', 'preview-export', 'redact']) $(id).disabled = busy;
  $('save-export').disabled = busy || previewId === null;
  for (const id of ['enable-integration', 'open-store', 'offer-export', 'save-diagnostics', 'remove-integration']) {
    $(id).disabled = busy || !installationConfigured;
  }
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
action('save-diagnostics', async () => {
  const result = await api('/installation/diagnostics');
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
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
  $('receipt').textContent = `${value.mode}\nState: ${value.state}\nAnchor: ${value.anchor}\nTimestamp: ${value.timestamp}\nVersion: ${value.id}\nEdit revision: ${value.editRevision}${value.managed?.message ? `\n${value.managed.message}` : ''}`;
  await loadReceipts();
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
  const state = await api('/status');
  const tabs = state.browser?.tabs ?? [];
  detected = tabs.length === 1 && tabs[0].active && tabs[0].surfaceSupported
    && tabs[0].composerEmpty && !tabs[0].attachmentsPresent ? tabs[0] : null;
  $('pairing').textContent = detected
    ? `Detected tab ${detected.id}: ${detected.destination}`
    : 'No single active, empty, supported ChatGPT tab is paired.';
  if (state.protection.eligibility === 'REVOKED') {
    scope = null; detected = null; selected = null;
    $('scope').textContent = 'Protection eligibility revoked. Existing receipts remain available.';
    $('pairing').textContent = 'The supported browser or provider state changed. Reopen the app and pair again.';
  }
}

action('refresh', refresh);
action('enroll', async () => {
  if (!detected) throw Error('Refresh and select one supported tab first');
  const result = await api('/enroll', { tabId: detected.id, destination: detected.destination });
  scope = result.scope; $('scope').textContent = `Enrolled scope: ${scope}\nDestination: ${result.destination}`;
  $('status').textContent = 'Scope enrolled. Compose locally and freeze one exact version.';
});

$('draft').addEventListener('input', () => {
  editRevision++;
  if (scope !== null) api('/draft', { text: $('draft').value, attachments: [], scope, editRevision })
    .catch(error => { $('status').textContent = error.message; });
  if (selected && selected.editRevision !== editRevision) $('status').textContent = 'Draft changed. The frozen version is stale; freeze a new version.';
  controls();
});
$('transaction').addEventListener('input', controls);
$('mode').addEventListener('change', () => { selected = null; controls(); });

action('freeze', async () => {
  selected = await api('/freeze', { text: $('draft').value, attachments: [], mode: $('mode').value, scope, editRevision });
  await receipt(selected);
  $('status').textContent = selected.mode === 'Continuous'
    ? `${selected.state}. Released without a pre-disclosure anchor claim.`
    : 'PENDING_FAST_CONFIRMATION. Nothing has been released.';
  await anchorManaged();
});

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
  $('status').textContent = 'Pending version cancelled. No downgrade or release occurred.';
});

action('close', async () => {
  clearInterval(pairingTimer); await api('/close'); scope = null; selected = null; detected = null;
  $('status').textContent = 'Local runtime closed.';
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
