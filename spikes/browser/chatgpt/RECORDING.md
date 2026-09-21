# Best-effort transport recording

Turn the integration ON once. Supported existing and new ChatGPT tabs/windows
are followed automatically. Use ChatGPT's own Send. **Prompt saved** means the
new prompt and its client observation are durably encrypted and signed locally.
Anchoring follows asynchronously. OFF stops new capture while preserving history
and already-durable anchor work. Capture never blocks, rewrites or replays Send.

## Acquisition and exact text

The extension bundles one MAIN-world fetch observer and an isolated relay at
`document_start`, scoped to `https://chatgpt.com/*`. `transport/chatgpt.mjs` owns
provider matching/extraction/acknowledgement; `transport/fetch-observer.mjs` owns
fetch observation and bounded streams; `transport/main.mjs` bridges the page.
None of the shared transport/parser modules depends on Chrome APIs. Run
`npm run build:observer` after editing these modules; `node
spikes/browser/chatgpt/build-observer.mjs --check` verifies the shipped bundle.
There is no XHR, WebSocket, webRequest, debugger, proxy, iframe or prototype hook,
remote executable adapter, CSP change, secondary recorder or provider refetch.

Supported requests are POSTs to exactly `/backend-api/conversation` or
`/backend-api/f/conversation` on the provider origin, without URL query/fragment
or credentials in the URL. The JSON must have `action: "next"`, a stable new user
message ID, a parent ID, and `content_type: "text"` with one string part.
A single new message is supported. A bounded history prefix is also accepted when
its final assistant message ID exactly equals `parent_message_id`, all message IDs
are unique, and the sole terminal new user message has a different ID. The parser
never scans backwards for an arbitrary user message or saves the history prefix.
The conversation ID must match the authenticated source (null for New Chat).
Anonymous endpoints/omitted credentials, prepare/history/resume, other operations,
attachments/voice/multimodal parts, explicit edits/resubmits and regeneration are
excluded. Reusing a saved message ID with changed text is a conflict. Unknown or
ambiguous shapes are rejected; a request indistinguishable from this supported
operation cannot independently establish what interaction caused it.

Only that string becomes evidence. Its validated UTF-8 retains BOM, whitespace,
CR/LF, combining characters and trailing newlines without trimming or Unicode
normalization. Prompt limit: 256 KiB. Serialized request limit: 2 MiB, allowing
JSON escapes at the prompt limit. Duplicate JSON keys, excessive nesting, invalid
UTF-8/lone surrogates and oversized bodies fail without truncation. Strings, URL
inputs, standard Requests and data-valued init overrides are supported; bodies
may be strings, ArrayBuffers/views or Blobs. Request bodies use a clone with a
750 ms read deadline. Direct stream/FormData/URLSearchParams bodies and accessor
init options report a gap, without reading/mutating the provider's body.
No request headers, credentials, history, model context or answer text are saved.

## Request authority and page state

While recording is ON, a supported validated outgoing request is the capture
event. No click, Enter, visible composer, Send button, focus, attachment indicator
or DOM timer may gate or veto it. The isolated relay arms the observer with an
opaque, renewable recording-policy binding, never an engine token. A matched
request snapshots that binding at fetch invocation, before asynchronous extraction
or page-message delivery. Unrelated requests and `/prepare` create no evidence.
The three-second policy freshness bound is renewed by the existing heartbeat;
it is not a time window after a human interaction.

DOM click/Enter listeners are optional diagnostics only. An apparent Send with no
matched request can report `REQUEST_NOT_OBSERVED` and a recording gap after 1.5
seconds. That advisory timer cannot create, cancel or expire an observation. A
later valid request still saves normally. Typing, hydration and DOM events alone
create no evidence. No event is cancelled.

Readiness comes from the supported route, observer availability and engine
policy. Empty/type/clear, rich editor markup, an absent Send button or rendered
message churn do not withdraw transport readiness. The existing sidebar remains
ON/OFF, effective status and Dashboard/History.

Observer health distinguishes a direct observer, a forwarding page wrapper, and
a replacement that bypasses observation. When fetch has a new outer function
identity, the readiness check calls it once with a private, already-aborted
`Request('data:,')`. The observer recognizes that object before capture or native
fetch and returns an empty local response. A bypass reaches only an aborted local
data URL, without provider network traffic. The check never creates a capture. Health is cached per function identity for that document, including
identities later reinstalled by the page. Heartbeats and inspections reuse the
cache without executing a known wrapper: it can have side effects before
delegating. The extension never re-wraps fetch or reinstalls it on SPA navigation.
An opaque wrapper changing its captured delegate without changing identity is
not observable by this check; optional DOM diagnostics can report a missing
request, but cannot guarantee detection of every missed request. Synchronous
wrappers forwarding the Request unchanged are supported. Deferred or transforming
wrappers that do not forward that probe synchronously fail closed. Health is an
advisory capability check, not proof of all future requests or page honesty.

Saved opt-in debug sessions include fixed `TRANSPORT_OBSERVER_*` codes (`READY`,
`WRAPPED`, `REPLACED`, `UNAVAILABLE`), `TRANSPORT_RELAY_READY`/`UNAVAILABLE`, and
`TRANSPORT_POLICY_READY`/`UNAVAILABLE`/`OFF`. These identify a live chain, a reachable
isolated relay, and an available capture policy separately. Missing or stale MAIN
heartbeats cannot establish observer readiness from relay injection alone. The
worker and native bridge each emit at most one event per code per connection;
these are stage sightings, not per-tab histories. Diagnostics contain no URLs,
function source/names, prompts, errors or page metadata. The expanded vocabulary
requires `pap-chatgpt-capture-diagnostic/3` negotiation; older peers receive none.
Request stages add `REQUEST_NOT_OBSERVED`, `REQUEST_MATCHED`,
`REQUEST_EXTRACTOR_REJECTED`, `REQUEST_MESSAGE_REJECTED`,
`REQUEST_MESSAGE_MISSING`, `DURABLE_SAVE_DISPATCHED` and `REQUEST_DEDUPLICATED`.
These distinguish an unseen request, a rejected body, an invalid/missing relay
message and a durable-save dispatch. Anchor retry scheduling and execution have
separate `ANCHOR_RETRY_SCHEDULED`/`ANCHOR_RETRY_STARTED` codes.

Page feedback follows matched request invocation order, with optional DOM Send
advisories. Late extraction, gaps or durable-save results may update their own
event, but cannot replace a newer event's result. Policy refresh preserves that
result while its source remains current; OFF and source revocation take precedence.

The isolated relay accepts a bounded request/ack message only for a matched
request in its own recording-policy binding. MAIN never receives an engine token
or control API. The worker supplies source metadata after authenticating extension
sender, active top-level Chrome document, tab/window, route, permissions and epoch.
Engine consent/source checks run again at the ordered cutoff. These are untrusted
client observations, not tamper-proof attestations about a hostile page or provider.

## Forwarding, acknowledgement and resource limits

Original fetch is called exactly once with its original receiver and arguments;
the page receives its original promise and Response. Capture, storage and
acknowledgement are detached. Provider rejection, abort, HTTP failure, stream
failure, missing/unknown acknowledgement and navigation cannot erase or downgrade
a saved observation. Storage failure cannot return **Prompt saved**.

A successful SSE response may yield a separate `chatgpt-early-ack/1` assertion.
The reader accepts a `stream_handoff` with a bounded exchange/topic ID, or an
inline new-user echo with the exact request message ID, or an empty assistant
message marked `in_progress`. Any supplied conversation must match the request.
The correlation is the same fetch closure, never the latest request in a tab.
HTTP status and completion alone are not semantic acknowledgement. No token is
decoded, WebSocket followed, full answer accumulated or history fetched.

The response clone reader inspects at most 64 KiB for at most two seconds; the
whole observation branch expires after four seconds from fetch invocation. It
cancels/releases only its own branch after ack, failure, abort or limit. Browser
chunks can exceed the inspection budget, and tee cloning can buffer additional
bytes on the provider branch: these are bounded inspection limits, not a claim
of zero overhead or control over the browser's chunk allocation.
There are at most eight active MAIN observations and sixteen isolated pending
requests per document. A missing request message expires after five seconds;
accepted relay records expire after 6.5 seconds. New-chat authority expires after
five seconds. Native deliveries are capped at 32. The page uses a 2.5-second
local-delivery deadline and at most one IPC retry; the worker deadline is two
seconds. This retries delivery of an observation, never the provider request.
Policy polls run each second and expire locally after three seconds.

The durable session indexes stable ChatGPT message IDs from signed history.
Repeated fetches, tab copies, route changes and reloads with the same identity
and exact text return the original receipt without new evidence or anchor work.
Reopen rebuilds the index, including historical transport observations. Distinct
message IDs remain separate even with equal text. Changed text or conflicting
known conversation identity rejects. Deduplication never rewrites the original
source, and an acknowledgement from a duplicate fetch is not attached to the
original event. Exact IPC retries retain their event ID and remain idempotent.

An ack cannot create a prompt and must reference its saved event/source/digest/
signing key. OFF/ON, restart, disconnect or permission loss cannot revive old
capture authority. An unavailable state cannot hide OFF.

Anchoring starts only after local durability. Temporary service, network,
rate-limit, quota or credit failure schedules at most two asynchronous retries,
after five and thirty seconds, within the existing durable three-external-attempt
budget. A saved transaction is reused for confirmation. Missing configuration or
credentials and invalid proof results are not automatically retried. Exhausted
work remains pending for an explicit retry or a later runtime if budget remains.
Timers, queued jobs and two active workers share a 512-job bound. OFF retains
already-durable anchor work; engine shutdown cancels scheduled timers. No anchor
job has a provider Send API.

## Navigation and evidence compatibility

The first validated request at New Chat may finish across the first same-document
`/c/<id>` transition. A five-second retained policy is bound to one event and
document. A fresh challenge targets that Chrome document ID, confirms the
pending exact request or saved ack, and rechecks live URL, permission and epoch.
A fresh route policy can arrive before the observer's request message. The
isolated relay retains the original recording-policy binding across that one
transition under the same runtime, browser session and tab epoch, for at most
five seconds. Neither a binding nor a matched-stage message creates evidence.
Once the exact validated request arrives, the worker and ordered engine bind one
first event. The continuation is pinned to that first route.
One status-only loading precursor is tolerated without granting new authority;
repeated loading, replacement documents, unrelated tabs/routes and OFF/ON revoke.
The evidence retains its original `new-chat` source.

Other same-document navigation, including conversation to New Chat, gets a fresh
source policy after a document-targeted route challenge. Chrome's stale creation
URL is accepted only for that authenticated document and current route. No old
conversation capture authority transfers to the new conversation.

Current contracts: adapter/8, page `2026-09-21`, capture/4, observation/5,
extraction `chatgpt-new-user-text/2`, acknowledgement `chatgpt-early-ack/1`.
`normal-request-observed` binds the exact new text, request metadata and source,
with `inputMethod: "provider-request"` and no human-interaction claim;
`normal-acknowledgement` binds the existing descriptor digest/event/source/key.
The verifier reports `OBSERVED_ONLY`, `UTF8_NEW_USER_MESSAGE`, client assertions
and unknown provider receipt. Ack is not proof of provider receipt, authorship,
ownership, event truth or complete history.

Historical observation/4 keeps its human-qualified transport meaning through
`qualified-observation.mjs`. Historical observation/3 remains a DOM intent/appearance assertion through
`dom-observation.mjs`; observation/2 and /1 retain their original readers and
signed meanings. No old artifacts are rewritten. Vault, key custody, recovery,
blinded anchoring and free export remain shared. Already-durable ON/OFF
observation/3 and /4 records retain their
existing bounded pending anchor workflow, without new capture authority;
pre-ON/OFF observation/2 remains read-only without new sponsorship. Diagnostics
retain bounded content-free codes; prompt/URL/credential telemetry is not added.

## Wire sources and validation limits

The synthetic wire fixtures derive from the pinned Observer source at
[31ad601](https://github.com/superbasedapp/observer/tree/31ad60124871f80504c1bf9fffe4ee477af78f2d):
[endpoint reconnaissance](https://github.com/superbasedapp/observer/blob/31ad60124871f80504c1bf9fffe4ee477af78f2d/browser-extension/src/content-main.js),
[request/stream shapes](https://github.com/superbasedapp/observer/blob/31ad60124871f80504c1bf9fffe4ee477af78f2d/browser-extension/src/parsers.js)
and [synthetic examples](https://github.com/superbasedapp/observer/blob/31ad60124871f80504c1bf9fffe4ee477af78f2d/browser-extension/src/parsers.test.js).
The implementation is original and intentionally narrower: it preserves text,
requires a positively identified new-user operation and stable identity, saves
before ack and never follows the answer stream.
The parent-linked history variant is an explicit synthetic schema boundary, not
a captured current live payload. These author-reported shapes are assumptions for this adapter, not our own live
ChatGPT verification. Unknown future shapes produce gaps/unknown ack.

Run `npm run test:chatgpt`, `npm run test:product` and
`npm run test:capture-browser` using the isolated
[testing guide](../../development/PRODUCT-TESTING.md). The browser fixture runs
the shipped observer and relay with genuine Chrome input, synthetic intercepted
network, a disposable profile, temporary vault and memory keys. External DNS is
blocked. Native ancestry is synthetic. Installed provider Sends, app-bound
custody, additional browsers/providers and owner acceptance remain unverified.
The earlier [DOM fixture result](../../../test/evidence/new-chat-chrome-153/capture.json)
is historical evidence for its own hashes, not validation of transport capture.

The [Chrome 153 transport result](../../../test/evidence/transport-chrome-153/capture.json)
records genuine-input synthetic-network coverage and exact script hashes for
the observer, isolated relay and worker. It does not establish live-provider or
installed native identity acceptance.

The [Chrome 153 wrapper-health result](../../../test/evidence/transport-health-chrome-153/capture.json)
adds full reload with a late forwarding wrapper, genuine bypass/recovery without
Send, and preservation of the page wrapper through heartbeats and SPA navigation.
It uses the same isolated synthetic-network boundary, not a live-provider run.

The [identity-cached health result](../../../test/evidence/transport-health-chrome-153/capture-identity-cache.json)
also counts page-wrapper side effects across idle heartbeats, repeated inspection,
replacement and restoration. Each outer function identity is validated once;
subsequent wrapper calls come only from the fixture's four synthetic Sends.

The [request-authority Chrome result](../../../test/evidence/request-authority-chrome-153/capture.json)
adds capture after removing composer controls, stable-message retry deduplication,
distinct equal-text message identities and OFF without DOM input. It records 13
checks and eight intercepted synthetic requests, with hashes for the observer,
relay, worker, engine, evidence readers and fixture. It does not establish live
provider payload compatibility or installed native identity acceptance.
