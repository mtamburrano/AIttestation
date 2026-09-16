# Sidebar trust and ON/OFF validation

The existing Chrome SIDE_PANEL has one integration-wide recording control,
connection/capability feedback and Dashboard / History. Views do not own recording
consent or capture workflows. A stale control learns the latest engine state and
asks the user to try again; it never automatically repeats the command.

Background STATE requests do not put the ON/OFF control into a busy state. Polls
coalesce, commands supersede older poll replies, and rendering assigns only changed
display values. The [refresh regression report](../../../test/evidence/new-chat-chrome-153/sidebar.json)
records a real Chrome 153 run with more than three polling intervals, zero toggle
DOM mutations and an enabled, identical button throughout stable OFF. The same
run checks actual state changes and the document-channel rejection cases below.
It uses a test-page gesture to open the sidebar and synthetic native ancestry.

## Browser context and requesting channel

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
[Chrome's Port lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#port-lifetime)
includes disconnection when the connecting frame unloads; the confirmation also
covers delayed notification. Same-document history changes need the separate
context ambiguity check described below.

The control gate applies these invariants:

- Each sidebar document navigates once to a fresh `sidepanel.html?view=<UUID>`.
  A consumed session-storage marker prevents loops. Reload/restore rotates the
  URL again. This marker stores no recording preference or secret.
- Full navigation is necessary: a `history.replaceState`/fragment-only probe did
  not update Chrome's sender URL. The URL is a document discriminator, not a
  bearer credential or a substitute for browser authority.
- The worker checks the Chrome-supplied extension ID, exact origin and URL shape;
  tab senders, child frames and non-active lifecycle metadata reject. Optional
  sender document IDs must match the live browser-owned ID when present.
- Controls use `runtime.connect()` with `pap-chatgpt-panel-channel/1`, one request
  per Port. The worker takes the browser-supplied `port.sender`; one-shot
  `PAP_PANEL_REQUEST` messages always reject. Ports and pending requests have
  bounded lifetimes and counts. A disconnect invalidates the requesting channel.
- `getContexts({})` examines **all URLs and types**, with at most 128 entries.
  Exactly one context must match the sender URL: a top-level, non-tab,
  non-incognito SIDE_PANEL with the exact origin and bounded opaque IDs.
  Every possible non-tab document requester must also be a top-level SIDE_PANEL.
  A popup, offscreen or other ambiguous non-tab context anywhere in this extension
  denies control until it closes. Regular extension tabs are excluded from that
  candidate set because Chrome identifies their callers through `sender.tab`,
  which the sender gate rejects. The background worker has its fixed script URL.
  Other extensions and ordinary website tabs are outside this inventory.
- After permissions, the same browser context/document IDs must still be present.
  Inventory alone does not bind the requesting document: a departed popup can
  leave a legitimate sidebar at its copied URL. After all asynchronous checks,
  the worker sends a fresh single-use challenge on the **requesting Port** and
  requires its exact reply on that same Port. Another sidebar cannot supply it.
  An unloaded document cannot answer, even if disconnect notification is delayed.
- Looking only at the sender URL is also insufficient while its Port is live:
  actual Chrome `history.replaceState` changes the inventory URL without changing
  `port.sender.url` or disconnecting. The exhaustive non-tab candidate check
  rejects this case. No URL, context ID or client-asserted role grants authority.
- The channel and native connection must still be current immediately before
  forwarding. Closing a view after an already authorized command was forwarded
  does not undo that command. Lost replies never cause automatic command replay.
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

### Historical metadata repair, recorded on 2026-09-15

The content-free [baseline report](../../../test/evidence/sidepanel-chrome-153/baseline.json)
and [toolbar report](../../../test/evidence/sidepanel-chrome-153/toolbar.json)
preserve the two executed runs. [ON](../../../test/evidence/sidepanel-chrome-153/sidebar-on.png)
and [OFF](../../../test/evidence/sidepanel-chrome-153/sidebar-off.png) screenshots
show the actual sidebar at `db90fe1`. These records establish the metadata repair
and ordinary interaction, not departed-sender rejection. The corresponding
`node --test test/*.test.mjs` run passed 317 tests with no failures or
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

### Document-channel validation, recorded on 2026-09-15

The [channel toolbar report](../../../test/evidence/sidepanel-chrome-153/channel-toolbar.json)
records the worker SHA-256, actual sparse Port sender shape and three explicitly
instrumented Chrome schedules. The [ON](../../../test/evidence/sidepanel-chrome-153/channel-on.png)
and [OFF](../../../test/evidence/sidepanel-chrome-153/channel-off.png) images show
the same sidebar with the new transport. No source sender or context inventory
is fabricated in these browser checks.

For each adversarial schedule the test creates a real action popup, sets its
window name in CDP, and fully navigates it to the legitimate sidebar's exact URL.
Only the disposable copy suppresses that named popup's fresh-URL UI bootstrap.
The test holds the worker's first context lookup after COMMAND dispatch. It then
navigates/closes the actual requesting document, observes real `Port.onDisconnect`,
and releases the lookup against Chrome's actual surviving contexts. The third
case uses `history.replaceState` without disconnecting. Test wrappers observe
completion and native forwarding; they do not replace authorization results.
The action popup and wrappers exist only in the fixture, never the product.

| Evidence | Result and boundary |
| --- | --- |
| Actual Chrome toolbar | State and ON/OFF work; dashboard, resident menu pipe and two sidebar windows agree; reload keeps OFF with zero captures |
| Actual Chrome full navigation and closure, controlled scheduling | Same-extension popup has the copied URL and sparse sender. Its Port disconnects; only the original sidebar remains at that URL. Both commands reject before native forwarding; recording and engine revision stay unchanged |
| Actual Chrome same-document navigation, controlled scheduling | The popup leaves the URL inventory but its Port stays live. Exhaustive non-tab enumeration rejects it; no command is forwarded |
| Deterministic synthetic departed-sender baseline | Before the channel fix, the new regression against `db90fe1` observed recording becoming true where false was required. This was a synthetic Chrome inventory/sender counterexample with the product native framing, engine and temporary encrypted vault |
| Current synthetic regressions | Delivered/delayed disconnect, same-document URL change, wrong-channel and replayed confirmations, malformed confirmations and one-shot control rejection. They assert unchanged recording/revision and zero native COMMAND forwarding |

An initial Port-only iteration passed real closure/navigation but failed the
same-document Chrome check. That failure motivated the exhaustive candidate
rule; Port liveness alone is not presented as sufficient. An ambiguous non-tab
context temporarily disables sidebar control across this extension. The shipped
manifest has no popup, offscreen or developer-tools page, so this adds no normal
product flow and grants no new permission.

Run the deterministic suite with `node --test test/chatgpt-sidepanel.test.mjs`.
It exercises actual product code with **synthetic** browser objects, memory keys
and isolated native IPC. It does not stand in for the Chrome results above.
The final full Node suite passed **322 tests**, zero failures or skips. The
focused sidebar, artifact-policy and package-leak run passed 47 tests. An earlier
full run found nine packaging-fixture failures because the synthetic archive
omitted the newly required channel module; its inventory was updated before
those successful reruns. The artifact verifier and upload check require the
module alongside the existing sidebar assets.

The browser UI and sender/context results are actual Chrome evidence. The native
process identity, keys and resident-menu pipe are fixtures, not evidence of signed
AppKit controls, app-bound Keychain access or installed native ancestry. The
browser fixture performs no provider Send and no TestNet operation. Real capture
markup and signed installation/owner acceptance still require the independently
reviewed build and the separately authorized owner checkpoint.
