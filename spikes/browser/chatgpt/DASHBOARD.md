# Resident menu, sidebar and dashboard

The Mac app keeps a status menu. It offers global recording ON/OFF, effective
availability, Dashboard/History, integration/settings, the free verifier and
explicit quit. Starting the app leaves browser views closed.

The existing Chrome **sidebar stays**. It contains one integration-wide toggle,
effective status and Dashboard/History. It has no prompt field, tab picker,
per-conversation settings or popup replacement. Its document-owned control channel
is described in [Sidebar trust](SIDEBAR.md). Background polling keeps the existing
button enabled and makes no DOM change when its displayed state is unchanged.
Commands remain serialized, and older poll replies cannot replace a newer command.

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
The dashboard displays 200 prompt groups per page and counts all retained groups.
The Need attention count filters the exact contributing rows, including older
pages. Only historical `OUTCOME_UNKNOWN` and `FAILED_BEFORE_EGRESS` contribute;
each row explains its reason and a safe manual next action. Unknown delivery
explicitly says not to resend automatically. Anchor-pending has a separate count
and does not by itself require attention. The count, highlighting, explanations
and filter share the same server-side mapping; signed history is unchanged.

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

Account refresh displays ACTIVE with remaining anchors and the returned monthly
period. Missing credentials, unpaid/expired accounts, quota exhaustion (including
ACTIVE with zero remaining), and service failures have distinct guidance. Only
allowlisted copy and validated quota/period fields render; no account token or
access code is echoed. Recording and evidence access remain independent.

Every action has a status region beside its control. Completion/failure is focused
and scrolled into view when necessary, including private debug export near the
bottom. If an action hides its controls, its feedback moves outside that hidden
container. The global message remains available, but is never the sole feedback.

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
