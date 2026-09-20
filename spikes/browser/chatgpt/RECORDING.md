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
or credentials in the URL. The JSON must have `action: "next"`, one new user
message with an ID, a parent ID, and `content_type: "text"` with one string part.
The conversation ID must match the qualified source (null for New Chat).
Anonymous endpoints/omitted credentials, prepare/history/resume, other operations,
attachments/voice/multimodal parts, edits/resubmits and regeneration are excluded.
The normal composer qualifier and payload exclusions jointly define this narrow
scope; this is not a universal detector of every provider operation.

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

## Human Send qualification and page state

A trusted primary click/keyboard activation of the unique enabled Send button,
or plain Enter in the unique visible enabled `#prompt-textarea`, supplies a
single-use qualifier lasting 1.5 seconds in that document. It never supplies
text or evidence by itself. The matching fetch supplies the text. Unrelated
URLs, methods, operations and conversations cannot consume the qualifier.
Shift/Ctrl/Meta/Alt+Enter, repeat, composition/229 and Enter within 50 ms of
composition end do not qualify. Synthetic input, typing and hydration do not
record. Attachment indicators prevent qualification. No event is cancelled.

Readiness comes from the supported route, observer availability and engine
policy. Empty/type/clear, rich editor markup, an absent Send button or rendered
message churn do not withdraw transport readiness. DOM text projection,
composer emptiness and rendered-message confirmation are removed. The minimal
qualifier still needs its supported controls when an actual Send occurs.
The existing sidebar remains ON/OFF, effective status and Dashboard/History.

Page feedback follows human Send order, including refused Sends and requests
whose bodies cannot be extracted. Late request messages, gaps or durable-save
results may update their own event, but cannot replace the latest Send's result.
Policy refresh preserves that result while its source remains current; OFF and
source revocation still take precedence over pending feedback.

The isolated relay accepts only a bounded request/ack message for its own pending
trusted qualifier. MAIN never receives an engine token or control API. The worker
supplies source metadata after authenticating extension sender, active top-level
Chrome document, tab/window, route, permissions and epoch. Engine consent/source
checks run again at the ordered cutoff. Page observations are untrusted client
assertions, not tamper-proof attestations about a hostile page or provider.

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
qualifiers per document. Up to 1,024 observed message IDs are retained per document
to exclude retries/resubmits from consuming later qualifiers; exhausting that
identity budget reports a gap until a fresh document. No prompt history is read.
Pending relay records expire after 6.5 seconds; new-chat
authority expires after five. Native deliveries are capped at 32. The page uses
a 2.5-second delivery deadline and at most one retry; the worker deadline is two
seconds. Policy polls run each second and expire locally after three seconds.

Each accepted Send has a fresh UUID, even for equal text. Identical delivery
retries are idempotent; conflicting retries fail. An ack cannot create a prompt
and must reference its saved event/source/digest/signing key. Duplicate acks are
idempotent; stale/foreign acks reject. OFF/ON, restart, disconnect or permission
loss cannot revive old capture authority. An unavailable state cannot hide OFF.

## Navigation and evidence compatibility

The first qualified request at New Chat may finish across the first same-document
`/c/<id>` transition. A five-second retained policy is bound to one event and
document. A fresh challenge targets that Chrome document ID, confirms the
pending exact request or saved ack, and rechecks live URL, permission and epoch.
A fresh route policy can arrive before the observer's request message. The
isolated relay retains bounded pending qualifiers across that transition under
the same runtime, browser session and tab epoch, without extending their original
1.5-second deadlines or creating evidence. Once the matching request arrives,
the worker and ordered engine bind one first event; its five-second continuation bound
remains and it is pinned to that first route.
One status-only loading precursor is tolerated without granting new authority;
repeated loading, replacement documents, unrelated tabs/routes and OFF/ON revoke.
The evidence retains its original `new-chat` source.

Other same-document navigation, including conversation to New Chat, gets a fresh
source policy after a document-targeted route challenge. Chrome's stale creation
URL is accepted only for that authenticated document and current route. No old
conversation capture authority transfers to the new conversation.

Current contracts: adapter/7, page `2026-09-20`, capture/3, observation/4,
extraction `chatgpt-new-user-text/1`, acknowledgement `chatgpt-early-ack/1`.
`normal-request-observed` binds the exact new text, request metadata and source;
`normal-acknowledgement` binds the existing descriptor digest/event/source/key.
The verifier reports `OBSERVED_ONLY`, `UTF8_NEW_USER_MESSAGE`, client assertions
and unknown provider receipt. Ack is not proof of provider receipt, authorship,
ownership, event truth or complete history.

Historical observation/3 remains a DOM intent/appearance assertion through
`dom-observation.mjs`; observation/2 and /1 retain their original readers and
signed meanings. No old artifacts are rewritten. Vault, key custody, recovery,
blinded anchoring and free export remain shared. Already-durable ON/OFF
observation/3 records retain their
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
requires explicit Send, saves before ack and never follows the answer stream.
These author-reported shapes are assumptions for this adapter, not our own live
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
