# Resident Mac app and local dashboard

The fixed signed Mac host runs an AppKit status menu. Starting the app does not
open the technical composer. The menu offers scoped readiness, global pause, the
Chrome/ChatGPT default, history, integrations, settings, the free verifier and
explicit quit. Neither the dashboard nor the extension panel must remain open
during capture. Reopening reads current engine state without replaying a send.

## State and authority

Two private inherited pipes at descriptors 6 and 7 connect the fixed runtime and
menu, separate from the Keychain broker at 3 and 4 and instance lock at 5.
`pap-desktop-command/1` admits only refresh, opening a fixed section, global pause,
integration default and quit. Policy commands include the displayed epoch and
revision and reuse engine stale-state checks. `pap-desktop-event/1` contains fixed
status codes, preferences and scope counts, without prompt bytes, URLs, bearer
tokens, conversation IDs, digests or keys. Frames and queues are bounded. Channel
loss closes the runtime; six seconds without a heartbeat clears the menu's
current-state claim. Keychain ownership checks, frozen identities and dispatch
contracts remain unchanged.

`/dashboard` is optional. `POST /dashboard/state` returns `pap-dashboard/1` under
the existing exact Host/Origin and random bearer checks. `/dashboard/command`
uses desktop admission; the historical `/` page retains the development workflow.
Requests cannot select a trusted command origin. The panel asks the runtime to
open the dashboard; the bearer never travels through the extension.

Installed, configured, connected, supported and healthy are separate observations.
Installation remains unverified until an authenticated extension connects. A
registered host or running process does not establish coverage. Readiness requires
a current enrolled scope and negotiated mode capability. Sealed readiness refers
to the panel input; each operation still requires anchoring and release checks.
Provider-page drafts remain outside that boundary.

Disable and removal disconnect the adapter and end scope authority before changing
its owned registration. Removal offers selective export or keeping local evidence.
Enable preserves unrelated configuration and rotates the rendezvous token; a fresh
browser connection and current scope selection are required. Chrome may need a
restart. Preferences, vault, keys and history survive. Conflicting configuration
is retained and reported, never overwritten.

## History, export and recovery

History groups authenticated frozen-version or normal-Send observations, not
internal vault records. Equal genuine sends remain distinct. Derivatives and
unassociated legacy cancellations remain selectable without adding prompts.
Conversation counts use known stable identities; unresolved new chats and legacy
records are explicitly unassigned. The dashboard shows the latest 200 prompts and
counts all retained groups. Older receipts remain selectable in the development
view. Cancellation and delivery uncertainty remain visible without automatic retry.

Local save, pending anchor, local source corroboration and retained portable proof
have distinct labels. Prompt text appears only in an explicit disclosure preview.
Each preview and Save action is bound to one immutable receipt selection and
Include exact evidence choice. Changing either clears the preview and invalidates
outstanding responses, even if the original choice is restored before they arrive.
An unchanged selection survives status refreshes and exports the reviewed snapshot.
Exports reuse the existing portable format and independent verifier. Recovery
uses the existing encrypted snapshot and a separately downloaded binary key.
Prepared copies expire after one minute or view closure. Existing recovery tools
restore into a new vault without old send authority. These paths do not depend on
sponsorship. Success feedback is quiet and content-free. Verifier shutdown gives
explicit feedback and tells the user to close the remaining browser tab.

## Repeatable private checks

- `npm test`: model/API/menu framing, interruption, account loss, export/recovery,
  configuration ownership, frozen identities, native compilation and package guards.
- `npm run test:product -- --scenario resident-dashboard`: shared local product
  harness with synthetic dependencies and explicit loopback-only networking.
- `npm run test:dashboard-browser`: actual dashboard rendering and controls in a
  fresh headless Chrome profile; includes close/reopen, pause, account loss, export,
  reversible integration, hostile text and narrow-screen layout. Deterministic
  response gates cover receipt/evidence changes during preview and export, later
  refreshes and unchanged-selection downloads with and without exact evidence.
  It saves a synthetic screenshot in a new temporary directory.
- `npm run test:recipient-browser`: additional legacy development/export flows.
  Its pre-existing post-reload quota scenario currently fails on the unchanged
  baseline. The dashboard browser check independently covers free verifier
  verification and shutdown.

All resources are temporary. These checks do not establish installed AppKit
interaction, real provider behavior or live confirmation. Use the documented
private setup for a separately approved installed checkpoint; ordinary regression
work does not change the retained test kit, Keychain or browser profile.
