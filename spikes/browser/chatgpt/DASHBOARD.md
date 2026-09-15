# Resident menu, sidebar and dashboard

The Mac app keeps a status menu. It offers global recording ON/OFF, effective
availability, Dashboard/History, integration/settings, the free verifier and
explicit quit. Starting the app leaves browser views closed.

The existing Chrome **sidebar stays**. It contains one integration-wide toggle,
effective status and Dashboard/History. It has no prompt field, tab picker,
per-conversation settings or popup replacement. Existing trusted-context checks
are preserved. Their installed-context false rejection and actual sidebar
interaction remain a separate validation boundary; synthetic tests do not claim
to fix it.

## State and authority

Private inherited pipes at descriptors 6 and 7 connect the fixed runtime and Mac
menu, separate from Keychain broker 3/4 and instance lock 5.
`pap-desktop-command/2` admits refresh, a fixed section, RECORDING with a boolean,
and quit. Recording commands include displayed epoch/revision. The
`pap-desktop-event/2` status contains fixed codes, recording and source counts;
no prompt bytes, URLs, bearers, conversation IDs, digests or keys. Frames/queues
are bounded. Channel loss closes the runtime; a six-second stale heartbeat
clears current-state claims.

Both `/` and `/dashboard` serve the dashboard. Its authenticated state is
`pap-dashboard/2`; commands use the shared engine's ON/OFF-only contract.
Host, Origin and random bearer checks remain. Requests cannot nominate a trusted
origin. The sidebar asks the runtime to open the dashboard; its bearer never
travels through the extension.

Installed, configured, connected, supported and recording are separate states.
Readiness requires an authenticated current source and supported capture
capability. ON alone does not promise successful capture. Closing a view keeps
the engine running; reopening reads current state without repeating actions.

Disable/removal revoke source permission before changing owned registration.
Removal offers export or retaining local evidence. Enable preserves unrelated
configuration and rotates rendezvous credentials; current browser pairing is
required, and Chrome may need restarting. Vault, keys, history and explicit
recording preference survive. Conflicting configuration is retained and reported.

## History, export and recovery

History groups genuine normal-Send observations and authenticated historical
records. Distinct equal-text Sends remain distinct. Legacy cancellations and
unknown outcomes stay readable with no action controls. Counts use known
conversation identities; unresolved/new chats and older records remain unassigned.
The dashboard displays the latest 200 prompt groups and counts all retained
groups; the engine/API and vault retain older evidence.

Local save, pending anchor, source corroboration and portable State-Proof assurance
have separate labels. Exact text appears only in an explicit disclosure preview.
Preview and Save bind an immutable selection and Include exact evidence choice.
Changing either invalidates pending responses, even when the original choice
is restored. An unchanged selection survives refresh and exports its reviewed
snapshot. Redaction remains a signed derivative with its own assurance.

Recovery uses the encrypted snapshot and separately downloaded binary key.
Prepared copies expire after one minute or view closure. Restoration targets a
new vault and starts recording OFF. Export, recovery and independent verification
remain free during account or service loss. OFF permits bounded pending anchor
work for already-durable evidence; it does not delete or recall evidence.

## Isolated checks

`npm test` covers menu framing, API controls, source invalidation, account loss,
export/recovery, configuration ownership and package guards.
`npm run test:product -- --scenario dashboard-recording` uses the shared
synthetic runtime harness. `npm run test:dashboard-browser` renders actual
dashboard controls in fresh headless Chrome, including disclosure response
races, account loss, integration controls, hostile text and narrow layout.
`npm run test:recipient-browser` exercises the independent verifier with
read-only legacy fixtures.

All resources are fresh and temporary. These results do not establish installed
AppKit/sidebar interaction, real ChatGPT behavior or live confirmation.
