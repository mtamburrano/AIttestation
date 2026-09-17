# Best-effort normal-Send recording

Turn the integration ON once. Supported existing and new ChatGPT tabs/windows
are followed automatically, including duplicate conversation tabs. Use ChatGPT's
own composer and Send. **Prompt saved** appears only after durable encrypted
signed evidence; anchoring follows asynchronously. OFF stops new capture while
keeping history and bounded already-durable anchor work.

## Supported observation boundary

- A trusted primary click or keyboard activation of the unique enabled
  `button[data-testid="send-button"]`, or plain Enter in the unique
  `#prompt-textarea`, signals intent. The event is never cancelled, replayed or
  replaced; Attestamp never injects text or clicks Send.
- Shift/Ctrl/Meta/Alt+Enter, repeating Enter, IME composition/229 events and Enter
  within 50 ms of composition end are excluded. A later explicit Send can qualify.
  Typing, hydration and DOM churn do not create prompt events.
- A provider render can momentarily hide, disable or duplicate the composer
  controls while the tab keeps the same document, which ChatGPT still accepts as
  a Send. Such a surface cannot observe a new Send at all, so it stops being
  reported as recording immediately: the page indicator and the tab status drop
  out of READY before any later Send, which then truthfully reports a gap instead
  of failing under a displayed ON. A bounded two-second churn window survives
  only as capture authority for a Send the page already observed, so that intent
  is still saved rather than dropped mid-render, and it closes and republishes on
  its own without waiting for another provider event. Only that one capability
  bit is tolerated: a different document, URL, window or destination, an
  attachment indicator, a sustained loss of the surface, OFF and disconnect all
  end recording immediately or on expiry.
- Textarea capture uses its value. Contenteditable capture projects text nodes,
  explicit BR newlines and P/DIV paragraph boundaries. A lone BR in an empty
  paragraph is a placeholder. Supported inline wrappers: span, strong, em, b,
  i, code, s and u. Mixed block/inline structures, hidden/unknown rich content,
  ambiguous composers/Send controls and attachment indicators produce a gap.
- Text must be well-formed UTF-8, at most 256 KiB, without trimming, BOM removal
  or Unicode normalization. The declared DOM projection may differ from a
  provider-transformed network payload. Existing drafts remain untouched.
- A unique exact-text user message with a bounded new `data-message-id`, absent
  from the intent's visible baseline, can add a separate appearance assertion
  within ten seconds in the same document. Old IDs, ambiguous matches and
  concurrent identical candidates remain unconfirmed.
- Attachments, voice, responses, edits/resubmits, regeneration and hidden requests
  are outside the contract. Page content can lie. Neither intent nor appearance
  proves provider receipt, authorship, ownership, event truth or complete history.

## Source, delivery and failure

The engine distributes `pap-chatgpt-capture/2` policies only while ON and eligible.
The worker validates the sender, top-level document, tab/window, URL, permissions
and document epoch, then supplies source metadata. The engine rechecks it at the
ordered cutoff. Page messages cannot choose another source or toggle recording;
sidebar controls cannot manufacture prompt evidence.

Each genuine intent has a fresh UUID. Identical transport retry keeps its event,
source and exact text. Distinct equal-text Sends retain distinct signed records
while encrypted byte storage can deduplicate. Each page retains at most 16 pending
intents; the bridge bounds capture deliveries to 32. Delivery has a two-second
worker deadline, 2.5-second page deadline and at most one retry of the original
observation. Policy refresh is every second and expires locally after three
seconds. OFF and invalidated policies discard pending page observations.
The page indicator follows effective state changes even when both policies are
empty: OFF clears an unavailable indicator. Stale refresh successes or failures
cannot replace a newer policy; unchanged ON refreshes preserve saved/gap feedback.
Missing later message appearance never changes a durable save into a primary
warning: the page continues to say **Prompt saved**. Appearance remains a separate
technical assertion and never establishes provider receipt.

### First Send in a new chat

There is one narrow navigation exception for the first genuine Send observed at
exactly `https://chatgpt.com/`. The worker can retain its old policy for at most
five seconds across the first `/c/<id>` route change. Chrome may report loading
even for this same-document navigation; loading alone cannot authenticate it.
Real Chrome delivers the navigation precursor and the conversation route as
separate tab updates, so one status-only loading update is tolerated for a
pending first-New-chat candidate while its route is still unknown. That
transition grants no capture authority, keeps the original document binding and
expires by itself; a second precursor, a later loading or any real navigation
revokes. It keeps the original tab/window, browser/runtime and document epoch. Before
forwarding, it challenges the original Chrome `documentId` with a fresh nonce;
that content script must still hold the same first intent, exact bytes and input
method captured before navigation, and now reside at the exact live tab URL.
The worker checks the live tab, permission,
epoch and retained policy again after the challenge. Navigation alone supplies
no evidence and cannot create an intent.

The engine retains only the corresponding New-chat policy for five seconds and
binds it to one event and document. This allowance is carried separately from the
signed observation; the evidence keeps its original `new-chat` source. Identical
delivery remains idempotent. A different event or later message appearance cannot
use retired authority. OFF/ON, disconnect, restart, permission loss, reload,
replacement/copy documents and further navigation revoke the exception. Normal
conversation captures still require current exact scope authority. Neither path
waits on, blocks, synthesizes or replays the provider action.

Chrome also retains the creation URL in content-script `MessageSender` after
this transition. A separate document-targeted URL confirmation can establish
the original document's new exact route for status polling. It carries no event
or text authority. A successful intent confirmation can establish the same route.
Later captures use the fresh conversation policy and scope; the retired token
cannot capture a later Send. This URL binding is removed on further navigation,
reload, permission loss or disconnection.

Storage, key, IPC, permission or markup failure produces a gap or unavailable
status without acknowledging a save or replaying Send. Delayed old acknowledgements
cannot replace newer gap feedback. Restart never backfills unobserved prompts.
An old capture policy cannot revive after OFF/ON or a new runtime epoch.

## Evidence and compatibility

New `pap-chatgpt-observation/3` intent records bind exact text and source;
appearance records additionally bind intent digest, event ID and signing key.
The standalone verifier reports OBSERVED_ONLY control, retrospective coverage,
client-only assertions and unknown provider receipt. It rejects manufactured
legacy control claims aimed at these observations.

Historical observation/1 and observation/2 retain their signed meaning through
isolated readers. Legacy history has no recording consent, anchor retry or Send
authority. Export/recovery preserves exact signatures, IDs and openings. Selected
source metadata/text is disclosed only in the previewed export; diagnostics
contain bounded fixed codes and temporary pseudonyms. A dropped Send is
attributable without page content: `PAGE_SEND_REJECTED` means the page declined
to observe the Send, `CAPTURE_REJECTED` means the worker refused it before
durable observation, and the engine's `CAPTURE_GAP` marks the ordered capture
decision. Each code is reported at most once per session.

Run `npm run test:chatgpt` and `npm run test:product` using the isolated
[testing guide](../../development/PRODUCT-TESTING.md). These execute actual
page/worker code against synthetic dependencies and do not establish installed
sidebar or real provider acceptance.

`npm run test:capture-browser` exercises a genuine Chrome input event and
same-document route change while holding a browser lookup across navigation.
Every page response is a synthetic intercepted fixture; external DNS is blocked.
It uses a disposable profile/extension, temporary vault, memory keys and synthetic
native ancestry, without a provider request or sponsor transaction. It complements
the deterministic failure/race cases; it does not establish installed ChatGPT
acceptance or app-bound key custody.

The [recorded Chrome 153 result](../../../test/evidence/new-chat-chrome-153/capture.json)
binds the test to the worker and content-script hashes. Chrome 153.0.8010.48
reported both `url` and `status: loading` for the fixture's `history.pushState`,
and kept the original sender URL. The test holds the first capture lookup until
the engine follows the conversation, then confirms one exact durable receipt,
a distinct equal-text later receipt and no new capture while OFF.
