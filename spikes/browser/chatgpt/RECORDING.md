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

The worker also injects these fixed packaged scripts into already-open supported
top-level tabs after installation/update or worker startup. Chrome's `scripting`
permission uses only the existing ChatGPT host grant. The isolated injection's
document ID pins the MAIN injection; revoked permission or a replaced document
ends recovery. Idempotent per-document instances avoid duplicate listeners and
observers. A new relay removes old indicators, retires old pending work and claims
a fresh observer owner; a retired relay cannot clear its successor's binding.
An invalid extension context removes its own indicator and listeners. The page
and provider requests continue without refresh, replay or a consent change.

Supported requests are authenticated POSTs to exactly `/backend-api/conversation`,
`/backend-api/f/conversation` or `/backend-api/f/steer_turn` on the provider origin, without URL query/fragment
or credentials in the URL. Extraction selects the latest entry whose
`author.role` is explicitly `user`, requires its stable message ID, and reads its
`content.parts`. It does not require a parent-linked history, validate other
history entries, or require a particular recipient, channel, content type,
conversation mode, model, feature configuration or known action value.

String parts and objects with a string `text` field contribute their text in
order, concatenated without added separators. Non-text parts are ignored for base
text evidence. A mixed image/document/text prompt still saves its exact text;
attachment bytes, names, pointers and metadata are never saved. The signed
observation explicitly declares attachments `UNSUPPORTED`. A media-only turn
reports a capability gap and cannot fall back to an earlier user's text.

Only explicit `edit`, `regenerate`, `resubmit`, `continue` and `variant` actions,
boolean `is_edit`/`is_regenerate`/`is_resubmit` flags on the operation or selected
turn/turn metadata, or reuse of the parent as the selected message identify
unsupported operations. Unknown actions and nested feature metadata do not veto
capture. An absent/invalid selected message ID or a repeated selected ID within
the batch is ambiguous. Reusing an already-saved ID with changed text or
conflicting known provider conversation identity is a durable dedup conflict.
The request alone cannot independently establish what human interaction caused it.

The authenticated source destination remains the route at request admission.
Provider `conversation_id` is separately preserved in `request.conversationId`;
it never supplies source authority. A missing or unusable provider ID becomes
null and emits a fixed notice. A valid non-empty ID differing from the route is
saved unchanged with a separate notice, without retargeting the source. Both
identities survive encrypted storage and portable export. A retry never rewrites
the original source or fills in its missing provider metadata.

Validated UTF-8 retains BOM, whitespace, CR/LF, combining characters and trailing
newlines without trimming or Unicode normalization. Prompt limit: 256 KiB.
Serialized request limit: 2 MiB, allowing JSON escapes at the prompt limit.
Invalid JSON, ambiguous duplicate evidence/operation keys, invalid UTF-8/lone
surrogates and oversized bodies fail without truncation. Unknown nested metadata
and duplicate irrelevant keys have no schema or depth veto; the body byte bound
still applies. Strings, URL inputs, standard Requests and data-valued init
overrides are supported; bodies may be strings, ArrayBuffers/views or Blobs.
Request bodies use a clone with a 750 ms read deadline. Direct stream/FormData/
URLSearchParams bodies and accessor init options report a gap without reading or
mutating the provider's body. No request headers, credentials, history, model
context or answer text are saved.

## Request authority and page state

While recording is ON, a supported validated outgoing request is the capture
event. No click, Enter, visible composer, Send button, focus, attachment indicator
or DOM timer may gate or veto it. The isolated relay arms the observer with an
opaque recording-policy binding, never an engine token. A matched
request snapshots that binding at fetch invocation, before asynchronous extraction
or page-message delivery. Unrelated requests and `/prepare` create no evidence.
Heartbeat scheduling does not expire capture admission. A delayed renewal still
allows a bounded snapshot under the original binding; current engine consent,
permission and source checks authorize its durable delivery. Explicit revocation
clears the binding and observations. A failed status poll reports unavailable
status while retaining the original binding for engine validation.

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
requires `pap-chatgpt-capture-diagnostic/4` negotiation; older peers receive none.
Request diagnostics distinguish the following stages:

| Fixed code | Meaning |
| --- | --- |
| `REQUEST_NOT_OBSERVED`, `REQUEST_MATCHED` | No matching invocation, or endpoint/source match |
| `REQUEST_BODY_READ_FAILED`, `REQUEST_BODY_LIMIT` | Unsupported/unreadable body, or request byte limit |
| `REQUEST_JSON_INVALID` | JSON decode failure or ambiguous evidence keys |
| `REQUEST_OPERATION_UNSUPPORTED`, `REQUEST_MEDIA_ONLY` | Explicit non-new-turn operation, or no supported text in a media turn |
| `REQUEST_PROMPT_MISSING`, `REQUEST_IDENTITY_MISSING`, `REQUEST_PROMPT_INVALID` | No identifiable text, no stable unambiguous message ID, or invalid/oversized text |
| `REQUEST_MEDIA_IGNORED` | Text remains capturable; non-text evidence is unsupported |
| `REQUEST_CONVERSATION_UNAVAILABLE`, `REQUEST_CONVERSATION_DIFFERENT` | Provider metadata absent/unusable, or differs from the authenticated route; capture continues |
| `REQUEST_MESSAGE_REJECTED`, `REQUEST_MESSAGE_MISSING` | Invalid or absent relay message |
| `DURABLE_SAVE_DISPATCHED`, `REQUEST_DEDUPLICATED` | Durable delivery started, or saved identity reused |

Notices do not produce a recording gap or cancel a pending save. No diagnostic
contains either conversation ID. Historical `REQUEST_EXTRACTOR_REJECTED` reports
remain readable but new observations no longer conflate these stages.
Anchor retry scheduling and execution have
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
Exhausting a response deadline reports **Save not confirmed · Check History**,
because the local write may already be durable. A correctly correlated late
success may confirm the original event within its existing 6.5-second lifetime;
it cannot revive OFF consent or replace a newer event's feedback. Explicit
rejection and extraction failures remain recording gaps. Deadlines and retry
counts are unchanged.
Policy polls run each second. The three-second observer readiness indicator is
advisory and does not expire an otherwise valid request's capture binding.

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
after five and thirty seconds, for at most three automatic calls per observation
per runtime. A saved transaction is reused for confirmation. Missing configuration
or credentials and invalid proof results are not automatically retried. Exhausted
batches leave durable pending evidence eligible for an explicit authenticated
anchor retry or a fresh bounded batch after app restart. The cumulative signed
attempt journal is never reset. Managed service reservations remain keyed to the
same account and blinded payload, with at most three broadcasts of the same
transaction; confirmation of a known transaction does not submit again.
Timers, queued jobs and two active workers share a 512-job bound. OFF retains
already-durable anchor work; engine shutdown cancels scheduled timers. No anchor
job has a provider Send API.

## Navigation and evidence compatibility

An event admitted by the isolated relay on an existing conversation retains its
immutable original source across same-document route changes until its bounded
delivery settles. Retiring a binding cannot admit additional events. The worker
challenges the same Chrome document for the exact pending event and payload,
checks the current route, permission and epochs, then supplies the original
source to the engine. Worker and engine retain at most 512 retired policies for
12 seconds; relay observations retain their shorter delivery limits. Reload,
replacement documents, tab/window changes, OFF/ON, permission loss and disconnect
revoke this continuation. Subsequent requests need the new route's binding.

If the worker forwards while the original source is still active, the engine
validates and snapshots that individual observation's admission before queueing
it. Same-document navigation while it waits cannot erase this admission. When
the queued operation runs, the original token must still be active or retained
within the bounded continuation window, with unchanged document and consent
authority. Consent commands keep their queue order: OFF ahead of an observation
rejects it; OFF behind an admitted observation preserves that earlier capture.
Neither a late unadmitted event nor a cleared token can borrow this admission.

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
Loading notifications, including repeated status-only updates, require a fresh
challenge to the exact original Chrome document at its current supported URL.
Their count does not establish document replacement or extend the request's
deadline. Replacement documents, unrelated tabs/routes and OFF/ON revoke.
The evidence retains its original `new-chat` source.

Other same-document navigation, including conversation to New Chat, gets a fresh
source policy after a document-targeted route challenge. Chrome's stale creation
URL is accepted only for that authenticated document and current route. No old
conversation capture authority transfers to the new conversation.

Current contracts: adapter/9, page `2026-09-21.1`, capture/5, observation/6,
extraction `chatgpt-new-user-text/3`, acknowledgement `chatgpt-early-ack/1`.
Steering adds one supported request path with the same extraction and signed
assertion semantics. Older verifiers that lack that path reject new steering
records; existing valid observations retain their original interpretation.
`normal-request-observed` binds the exact new text, request metadata and source,
with `inputMethod: "provider-request"` and no human-interaction claim;
`normal-acknowledgement` binds the existing descriptor digest/event/source/key.
The verifier reports `OBSERVED_ONLY`, `UTF8_NEW_USER_MESSAGE`, client assertions
and unknown provider receipt. Ack is not proof of provider receipt, authorship,
ownership, event truth or complete history.

Historical observation/5 keeps its strict extraction and route/provider equality
contract through `strict-observation.mjs`. Historical observation/4 keeps its human-qualified transport meaning through
`qualified-observation.mjs`. Historical observation/3 remains a DOM intent/appearance assertion through
`dom-observation.mjs`; observation/2 and /1 retain their original readers and
signed meanings. No old artifacts are rewritten. Vault, key custody, recovery,
blinded anchoring and free export remain shared. Already-durable ON/OFF
observation/3, /4 and /5 records retain their
existing bounded pending anchor workflow, without new capture authority;
pre-ON/OFF observation/2 remains read-only without new sponsorship. Diagnostics
retain bounded content-free codes; prompt/URL/credential telemetry is not added.

## Wire sources and validation limits

The parser behavior was cross-checked against pinned public sources:

| Source | Relevant behavior | Deliberate Attestamp difference |
| --- | --- | --- |
| [Observer 0456d679](https://github.com/superbasedapp/observer/blob/0456d679b0afd6a0f8b582bd5ba414a6c2cdf902/browser-extension/src/parsers.js) | `parseChatGPTRequest` walks backwards for a user and joins string parts without validating the envelope | Never trim or truncate evidence; accept direct text-bearing parts too |
| [Agent Beacon d6a62a4a](https://github.com/Asymptote-Labs/agent-beacon/blob/d6a62a4aefdc8b675f691bf927a99323bfb1aefd/browser-extension/src/adapters/chatgpt.ts) | `extractPrompt` keeps the latest user text; `coerceParts` joins strings and objects with string `text` | Require an explicit user role and stable provider message ID; never coerce an unknown role to user or retain history |
| [ccproxy f2c47695](https://github.com/starbaser/ccproxy/blob/f2c47695b0835da023257aee0ac2a3dffd9fe570/src/ccproxy/lightllm/adapters/openai_conversations.py) | `MessageContent.parts` permits heterogeneous text and image-pointer elements; new conversation bodies omit `conversation_id` | Observe the original fetch only, preserving text while declining attachment evidence |

Four [sanitized owner-captured request fixtures](../../../test/fixtures/chatgpt-wire/README.md)
preserve the real 2026-09-21 text, image and document wire structures. The
[baseline comparison](../../../test/evidence/request-wire-baseline.json) shows
text accepted by the prior parser but vetoed by route/provider equality, plus
image/document extractor failures. All four now capture under both new-chat and
conversation source bindings, without changing the provider fetch.

The owner-derived `steer-turn.json` projection retains the reported steering
fields and exact `/backend-api/f/steer_turn` endpoint confirmed on 2026-09-22.
The same latest-user extraction applies while an assistant response is open;
save does not wait for either response to finish. Other steering-like paths
remain unsupported, and known edit/regenerate/resubmit/continue/variant
operations remain excluded. The fixture README distinguishes this reduced
projection from the four full sanitized wire bodies.
The [steering baseline](../../../test/evidence/steering-baseline.json) compares
the same projection against `8a7460a`; its ordinary-conversation control passes
while steering is unmatched. The [Chrome steering result](../../../test/evidence/steering-chrome-153/capture.json)
adds genuine Send input with an intercepted response held past the advisory
deadline: exact evidence is durable and the page reports Prompt saved before
the provider response is released. Live installed steering remains unverified.

These comparisons informed an original implementation. Endpoint, source/document,
consent, exact-byte, resource and stable-identity checks protect attribution and
evidence integrity; they do not impose a schema on irrelevant metadata. Known
unsupported operation checks are narrow. Tests cover arbitrary nested feature
keys, history variations, future actions/types, mixed content, missing/conflicting
route metadata, diagnostic privacy, deduplication and historical readers.
Public sources and synthetic tests alone do not establish current live coverage.

Run `npm run test:chatgpt`, `npm run test:product` and
`npm run test:capture-browser` using the isolated
[testing guide](../../development/PRODUCT-TESTING.md). The browser fixture runs
the shipped observer and relay with genuine Chrome input, synthetic intercepted
network, a disposable profile, temporary vault and memory keys. External DNS is
blocked. Native ancestry is synthetic. Installed provider Sends, app-bound
custody, additional browsers/providers and owner acceptance remain unverified.
The earlier [DOM fixture result](../../../test/evidence/new-chat-chrome-153/capture.json)
is historical evidence for its own hashes, not validation of transport capture.

The [loading-continuity result](../../../test/evidence/new-chat-chrome-153/loading-continuity.json)
adds repeated loading and route updates during first New Chat Sends in a fresh
tab and after returning from a conversation. The updates are injected into the
real Chrome worker; the original document challenges, provider request, delayed
SPA route and held relay are exercised with intercepted synthetic traffic.
It does not establish the precise live provider event schedule.

The [capture-response result](../../../test/evidence/capture-responsiveness-chrome-153/capture.json)
holds real Chrome local-save replies past both deadlines: History gains one
record, the page reports an unconfirmed save, and a late correlated reply reports
Prompt saved without another provider request. Separate deterministic tests hold
two native verifier processes while a 15-record synthetic backlog, new capture
and authenticated debug/control requests run. Offline fast and archival proof
tests compare synchronous and asynchronous verdicts, including tampered proofs.
These tests do not establish the cause or timing of an owner-observed live delay.

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

The [request-continuity Chrome result](../../../test/evidence/request-authority-chrome-153/capture-continuity.json)
adds held request and acknowledgement delivery across an existing conversation's
same-document navigation, followed by a request on the new route. Its 15 checks
and ten intercepted requests retain the same synthetic traffic and native-peer
limitations. Deterministic tests separately cover late and failed policy renewal,
consent revocation during a document challenge, and anchor recovery after a full
automatic retry batch and restart with unchanged sponsor accounting.

The [request robustness Chrome result](../../../test/evidence/request-wire-chrome-153/capture.json)
adds text capture with missing provider conversation metadata, independent route
and provider IDs, unknown feature fields, mixed ordered text parts, and a
media-only capability gap. It also replays all four sanitized owner-captured request shapes. It records 19
checks and 17 intercepted requests;
provider traffic, native peer identity and keys remain synthetic and isolated.
