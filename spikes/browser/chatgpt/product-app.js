const secret = location.hash.slice(1); history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let detected = null, scope = null, selected = null, editRevision = 0, busy = false;

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
}

function receipt(value) {
  $('receipt').textContent = `${value.mode}\nState: ${value.state}\nAnchor: ${value.anchor}\nTimestamp: ${value.timestamp}\nVersion: ${value.id}\nEdit revision: ${value.editRevision}`;
}

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
  if (selected && selected.editRevision !== editRevision) $('status').textContent = 'Draft changed. The frozen version is stale; freeze a new version.';
  controls();
});
$('transaction').addEventListener('input', controls);
$('mode').addEventListener('change', () => { selected = null; controls(); });

action('freeze', async () => {
  selected = await api('/freeze', { text: $('draft').value, attachments: [], mode: $('mode').value, scope, editRevision });
  receipt(selected);
  $('status').textContent = selected.mode === 'Continuous'
    ? `${selected.state}. Released without a pre-disclosure anchor claim.`
    : 'PENDING_FAST_CONFIRMATION. Nothing has been released.';
});

action('request', async () => {
  $('anchor').textContent = JSON.stringify(await api('/anchor-request', { id: selected.id }), null, 2);
});

action('confirm', async () => {
  const frozen = selected;
  selected = await api('/confirm', { id: frozen.id, transactionId: $('transaction').value,
    scope, currentText: frozen.mode === 'Continuous' ? undefined : $('draft').value,
    attachments: [], editRevision });
  receipt(selected);
  $('status').textContent = selected.mode === 'Always Protect'
    ? `${selected.state}. Confirmed exact version was released automatically.`
    : 'SOURCE_CORROBORATED / SOURCE_REPORTED. No stronger timestamp claim is made.';
});

action('release', async () => {
  selected = await api('/release', { id: selected.id, scope, currentText: $('draft').value,
    attachments: [], editRevision });
  receipt(selected); $('status').textContent = `${selected.state}. Provider receipt remains unknown.`;
});

action('cancel', async () => {
  selected = await api('/cancel', { id: selected.id, scope }); receipt(selected);
  $('status').textContent = 'Pending version cancelled. No downgrade or release occurred.';
});

action('close', async () => { await api('/close'); $('status').textContent = 'Local runtime closed.'; });
refresh().catch(error => { $('status').textContent = error.message; }).finally(controls);
