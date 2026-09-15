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
contain bounded fixed codes and temporary pseudonyms.

Run `npm run test:chatgpt` and `npm run test:product` using the isolated
[testing guide](../../development/PRODUCT-TESTING.md). These execute actual
page/worker code against synthetic dependencies and do not establish installed
sidebar or real provider acceptance.
