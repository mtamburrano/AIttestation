# Sealed in the Chrome side panel

Open the Attestamp Chrome toolbar button, choose the visible ChatGPT conversation,
and write a text prompt in the panel. **Protect and send** submits one immutable
version to the resident Mac engine. The engine saves encrypted evidence, obtains
and validates source-corroborated confirmation, durably consumes its one-use
authorization, and dispatches to that exact tab/document. Before confirmation the
provider receives no protected text. The panel does not need to remain open.

Off, Continuous and Sealed are conversation preferences held by the engine. Sealed
is the scoped Always Protect preference; it does not enforce use of the panel or
restore an old send. A new-chat preference lasts for that current document only.
Pause ends pending authority across scopes; resuming permits new explicit actions.
The integration default and account connection are available in the dashboard.

The selected conversation stays pinned when another tab becomes active. Each
selected target has a separate in-memory panel draft. A pending operation cannot
borrow another target, newer text or a later draft revision. Closing the panel
discards unsent drafts. Reopening reads current operations without reconstructing
or replaying a command. An operation requires its original active, supported,
empty target at release; losing that capability ends the pending send. There is
no automatic resume on return to that tab.

Text typed directly into ChatGPT is already outside Sealed admission. The panel
discloses this bypass and reports existing provider drafts, unsupported attachments
and ambiguous controls. It never clears or imports a provider draft. Protection
applies to text explicitly admitted through Attestamp, not the whole tab. Normal
Send under Continuous remains a separate retrospective observation path.

## Failures and safe actions

The panel displays account, allowance, outage and confirmation failures without
falling back to Continuous. Cancel ends future controlled release and retains a
portable signed cancellation assertion. It cannot erase public anchors or provider
copies. Uncertain post-exposure outcomes remain unknown and offer no retry action;
check ChatGPT before deliberately starting another prompt. A lost acknowledgment
requires a status refresh, never automatic resubmission. Double clicks in a view
are suppressed, delivery IDs are idempotent in the engine, and concurrent pending
admission in the same scope is rejected.

“Send click observed” is a local assertion. It does not prove provider receipt,
authorship, ownership or consensus time. The existing free dashboard receipts and
independent exports retain their assurance distinctions.

## Panel admission and compatibility

Extension 1.6.0 negotiates additive `pap-chatgpt-panel/1` alongside the unchanged
adapter `/5`, release `/2` and capture `/1` contracts. The frozen extension public
key/ID, native allowlisted origin, signing identities, trust roots and historical
evidence formats are unchanged. Older `/5` peers without panel negotiation retain
their existing capabilities but cannot use panel requests.

The only new permission is `sidePanel`. The host permission remains exactly
`https://chatgpt.com/*`; there is no tabs, storage, clipboard, downloads or broad
site permission. The extension has no external messaging or web-accessible panel
resource. Its CSP permits packaged scripts/styles only and prohibits framing,
forms and network connections from the panel page.

Chrome's documented [side-panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
provides the extension page and toolbar behavior. The worker uses
[`runtime.getContexts`](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts)
to verify the active `SIDE_PANEL` document. Sender origin, exact page URL, document
identity and non-incognito context must agree. A content script or the same HTML
opened as a regular tab cannot impersonate this path. See Chrome's
[message security guidance](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations).

Requests pass through the existing authenticated native relay and peer validator.
The worker supplies the native request ID and encodes the exact UTF-8 text as
bounded base64. The native handler accepts only state, local dashboard opening,
and enrollment, conversation mode, pause, protect/send or cancellation commands.
It supplies the `extension_panel` origin to the engine; callers cannot choose it.
Unknown fields, malformed text, stale epochs/revisions and unnegotiated profiles
reject. There are at most eight concurrent panel requests per bridge and a
ten-second view response deadline. A view timeout grants no retry authority.

Replies contain bounded view state and operation outcomes, without prompt bytes,
digests, vault records, signing access or account tokens. Dashboard opening happens
inside the Mac runtime; its bearer URL is never returned to the extension.
Preferences, evidence, anchoring and release decisions remain exclusively in the
engine. Only view-local drafts and selections live in the panel.

## Repeatable private verification

`npm run test:chatgpt` includes `test/chatgpt-sidepanel.test.mjs`, exercising the
actual panel model, service worker, content script, native frames, engine and
encrypted temporary vault with synthetic Chrome/platform/provider/anchor APIs.
It covers stale edits, replay, independent tabs, navigation, pause/cancel, hostile
messages, reconnection, outages, unknown outcomes and exact leading BOM bytes.

`npm run test:product -- --scenario panel-protect-and-send` runs the same components
under the existing fixture network guard. `panel-cancel` and
`panel-destination-change` also verify portable cancellation and no dispatch.
All three are included in the default product run. Reports remain content-free.

`npm run test:sidepanel-browser` renders the actual HTML/CSS/modules in headless
Chrome, uses a fresh temporary profile with external DNS blocked, and drives its
real controls through synthetic Chrome messaging. It checks provider-draft
disclosure, immutable sending, double clicks, narrow layout and reopening. A
synthetic screenshot is retained in the reported temporary preview directory.
This verifies rendering, not installed Chrome side-panel or native identity.

Distribution regressions verify panel resources in the app and extension ZIP,
exact permissions/CSP, and the frozen identity baseline. Local tests do not install
or register anything in a retained browser profile, use operational keys, send
live prompts/transactions, or publish a Store build. The installed native boundary
and actual provider remain separate authorized owner checks.
