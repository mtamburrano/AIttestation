# Sidebar trust and ON/OFF validation

The existing Chrome SIDE_PANEL has one integration-wide recording control,
connection/capability feedback and Dashboard / History. Views do not own recording
consent or capture workflows. A stale control learns the latest engine state and
asks the user to try again; it never automatically repeats the command.

## Browser-owned document identity

Chrome 153.0.8010.37 on macOS was observed to supply only `id`, `origin` and `url`
for a toolbar-opened sidebar's `runtime.onMessage` sender. Its live
`runtime.getContexts()` entry has `contextType: SIDE_PANEL`, `frameId: 0`,
`tabId: -1`, `windowId: -1`, `incognito: false`, and an opaque 32-character
`documentId`. The sender has neither `documentId` nor `documentLifecycle`.
A real `runtime.connect()` probe also omitted those two sender fields.

The prior gate required both missing sender fields and a hyphenated UUID shape.
The isolated baseline worker from `0ee568b` returned `UNTRUSTED_PANEL` after
`BRIDGE_CONNECTED`, `BRIDGE_AUTHENTICATED` and `BRIDGE_HELLO`. The toolbar-opened
sidebar was read-only. This reproduces the rejection after pairing; it does not
claim a reproduction of the owner's entire signed installation.

[Chrome's runtime API](https://developer.chrome.com/docs/extensions/reference/api/runtime)
describes these identifiers as optional sender metadata. Platform identifiers are
opaque: tests must not invent a required encoding or missing property.

The repaired gate applies these invariants:

- Each sidebar document navigates once to a fresh `sidepanel.html?view=<UUID>`.
  A consumed session-storage marker prevents loops. Reload/restore rotates the
  URL again. This marker stores no recording preference or secret.
- Full navigation is necessary: a `history.replaceState`/fragment-only probe did
  not update Chrome's sender URL. The URL is a document discriminator, not a
  bearer credential or a substitute for browser authority.
- The worker checks the Chrome-supplied extension ID, exact origin and URL shape;
  tab senders, child frames and non-active lifecycle metadata reject. Optional
  sender document IDs must match the live browser-owned ID when present.
- `getContexts({documentUrls: [sender.url]})` must return exactly one context
  across **all** types. It must be a top-level, non-tab, non-incognito SIDE_PANEL
  with the exact origin and URL. Filtering to SIDE_PANEL first would hide an
  impersonating popup and is forbidden. Browser IDs are bounded opaque strings.
- After the permission check, the worker resolves the context again and requires
  the same context/document IDs. Closure or replacement cannot borrow authority
  during the asynchronous check. The native connection must still be current.
- The existing authenticated native chain and engine command schema, epoch,
  revision, replay protection and capture-role separation remain required.

Regular extension tabs and action popups do not gain control by loading the same
HTML. Framing and incognito remain denied by the existing manifest. The sidebar
contains no prompt-writing or provider-Send API.

## Bounded diagnostics

`PAP_READY.panelDiagnosticProfile` separately advertises
`pap-chatgpt-panel-diagnostic/1`. Without it, the worker does not send new diagnostic
messages to an older control-only peer. The bridge accepts only paired messages
with exactly `kind`, `profile` and one allowlisted `code`:

- `PANEL_SENDER_REJECTED`
- `PANEL_URL_REJECTED`
- `PANEL_MESSAGE_REJECTED`
- `PANEL_CONTEXT_REJECTED`
- `PANEL_CONTEXT_UNAVAILABLE`
- `PANEL_PERMISSION_REJECTED`
- `PANEL_CONNECTION_UNAVAILABLE`

Both ends deduplicate each stage per connection. The existing bounded collector
and opt-in persistent debug session own retention/export. No request content,
sender URL, document ID, context ID, secret, raw content digest or arbitrary
platform error is copied into diagnostics. Disconnection can prevent an event
from reaching the engine; these codes are not a complete failure counter.

## Repeatable tests and evidence limits

Run from a trusted checkout with Node 22.13+ and Chrome 153 installed at
`/Applications/Google Chrome.app`:

```sh
npm run test:sidepanel-browser -- --manual-toolbar
```

The fixture prints a disposable app path and waits for its toolbar action. Open
Attestamp from that specific Chrome window's Extensions menu. The remaining checks
run automatically. Without `--manual-toolbar`, a dedicated extension test page
opens the sidebar using a test gesture; the report identifies that difference.
The test requires macOS GUI access and local socket access through the sandbox.

To reproduce the original failure against the same ON/OFF contracts:

```sh
baseline=$(mktemp /private/tmp/attestamp-sidebar-baseline-test-XXXXXX)
git show 0ee568b:spikes/browser/chatgpt/extension/service-worker.js > "$baseline"
node test/sidepanel-browser.mjs --manual-toolbar --expect-rejection --worker "$baseline"
rm "$baseline"
```

Each run creates a new temporary app clone, Chrome profile, extension copy,
encrypted vault, memory keys, socket and engine. External DNS is blocked;
Crashpad is disabled and Chrome uses its test keychain. No provider page is
opened and managed anchoring is explicitly absent. A test-only native-port shim
in the disposable extension relays through the product native framing and
rendezvous authentication. Peer ancestry is explicitly synthetic. It never
registers a native host or changes the retained test kit, OS Keychain or sponsor
ledger. Production resources never include the shim or extension test page.

The runner closes and removes only its own app/profile/runtime. It leaves a
separate temporary report directory with bounded metadata, diagnostics and
sidebar screenshots. It reports zero provider/sponsor operations. Reports from
failed attempts remain distinct from a successful run.

### Recorded on 2026-09-15

The content-free [baseline report](../../../test/evidence/sidepanel-chrome-153/baseline.json)
and [toolbar report](../../../test/evidence/sidepanel-chrome-153/toolbar.json)
preserve the two executed runs. [ON](../../../test/evidence/sidepanel-chrome-153/sidebar-on.png)
and [OFF](../../../test/evidence/sidepanel-chrome-153/sidebar-off.png) screenshots
show the actual sidebar. These records are evidence, not synthetic golden results.
The final `node --test test/*.test.mjs` run passed 317 tests with no failures or
skips, including the control, capture, bridge, persistent diagnostics, migration,
legacy evidence and distribution regressions. All used isolated local resources.

| Evidence | Result and boundary |
| --- | --- |
| Actual Chrome, toolbar baseline | False `UNTRUSTED_PANEL` reproduced after fixture native authentication; real sender/context metadata recorded |
| Actual Chrome, repaired toolbar | State read and ON/OFF work; dashboard, resident pipe and two sidebar windows share engine consent |
| Actual Chrome hostile views | Real extension tab, dedicated extension test page and action popup reject; framed page has no accessible extension runtime; incognito API reports access disabled |
| Actual Chrome reload | New document URL, OFF retained, no new evidence or replay |
| Synthetic/adversarial regression suite | Copied-URL collisions, wrong origin/context, incognito metadata, API failures, permission loss, closure/replacement, stale commands and diagnostic privacy/limits |
| Synthetic capture regression suite | Existing/new supported sources, multiple windows, focus/navigation and closed views; exact capture, OFF cutoff, durable save and asynchronous anchor semantics |

The browser UI and sender/context results are actual Chrome evidence. The native
process identity, keys and resident-menu pipe are fixtures, not evidence of signed
AppKit controls, app-bound Keychain access or installed native ancestry. The
browser fixture performs no provider Send and no TestNet operation. Real capture
markup and signed installation/owner acceptance still require the independently
reviewed build and the separately authorized owner checkpoint.
