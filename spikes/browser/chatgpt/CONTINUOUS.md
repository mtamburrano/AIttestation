# Normal-send Continuous capture

In the local app view, enroll a supported ChatGPT conversation and apply its
**Continuous** mode. Use ChatGPT's own composer and Send button. The extension
reports **Prompt saved** only after the engine durably stores the selected bytes
and signed intent. Anchoring runs afterward; a pending anchor does not remove
the local receipt. The app view can be closed during capture.

Off and global pause end recording for the affected scopes. Established
conversation preferences apply to independently enrolled duplicate tabs; each
tab has its own document and event identities. New-chat consent applies only to
that enrolled document. Navigation/reload requires enrolling the current target;
neither old capture delivery nor protected release can move to another destination.

## Supported observation boundary

- A trusted primary click on the unique enabled `button[data-testid="send-button"]`,
  including keyboard activation of that button, or plain Enter in the unique
  `#prompt-textarea` composer signals submission intent. No event is cancelled,
  replayed or replaced, and no prompt text or Send click is injected.
- Shift/Ctrl/Meta/Alt+Enter, repeating Enter, IME composition/229 events and Enter
  within 50 ms of composition end are excluded. An explicit later Send is needed
  to produce a supported intent. Edits before that action use the then-current text.
  Conversation edit/resubmit controls, regeneration, voice input, attachments,
  responses and hidden requests are outside this observation contract.
- A textarea contributes its value. A contenteditable contributes its text nodes,
  explicit BR newlines and P/DIV paragraph boundaries. A lone BR in an empty
  paragraph is a placeholder. Supported inline wrappers are span, strong, em, b,
  i, code, s and u. Mixed block/inline structure, hidden or unknown rich content,
  multiple composers/Send controls and attachment indicators produce a gap.
  Text is well-formed UTF-8, at most 256 KiB, without trimming or Unicode
  normalization. This is a declared DOM projection, not the provider's transformed
  network payload.
- Typing, input events, hydration and DOM churn never create prompt events. A
  subsequent unique, exact-text user message with a bounded `data-message-id`
  absent from the intent's visible baseline may produce a separate appearance
  assertion. It must be in the same page/document and within ten seconds. Old IDs,
  ambiguous matches and concurrent identical candidates stay unconfirmed. The
  page can lie; neither intent nor DOM appearance establishes provider receipt.

## Delivery, failure and storage

The engine alone computes scoped capture policies after explicit enrollment and
mode selection. Policy tokens are memory-only and confer no send authority. The
worker authenticates the extension sender, top-level active document, current
tab/window, URL, permissions and document epoch before adding source metadata.
The engine rechecks the source and current policy on receipt. Content scripts
cannot issue resident control commands or choose a different source scope.

Each user intent has a fresh UUID; transport retries keep that same event and
exact source/text. Equal-text genuine submissions produce distinct signed
records while sharing an encrypted byte object. At most sixteen pending intents
per page and 32 bridge deliveries are retained. Delivery has a two-second worker
deadline, a 2.5-second page deadline and at most one retry, using only the original
observation. Capture policy is refreshed every second and expires locally after
three seconds without a successful check. Failed storage/keys/IPC produce a gap
or recording-unavailable state; they never replay or block the normal user send.
An older delayed acknowledgement cannot replace a newer recording-gap message.

The engine stores `pap-chatgpt-observation/2` intents and optional appearance
assertions. No release seal, dispatch attempt or authorization is created.
Recovery retains receipts and their source metadata, with no enrollment, pending
observation or old token restored. Selected exports contain source identifiers
and exact bytes only as previewed; diagnostics contain fixed codes and temporary
pseudonyms. The standalone verifier reports retrospective `OBSERVED_ONLY` control
and client-only assertions. Historical `pap-chatgpt-observation/1` and release
records retain their bytes and semantics; native and release wire identities are
unchanged. Old extensions without capture negotiation remain unavailable for
normal-send Continuous.

## Isolated validation

Run `npm run test:chatgpt` and `npm run test:product`. The latter includes
`continuous-normal-send`, `continuous-storage-gap`, `continuous-key-gap` and
`continuous-connection-gap`. These run the actual content script, extension
worker, native framing, resident engine and encrypted vault against synthetic
DOM/browser/platform and anchoring dependencies. They cover input variations,
retries, simultaneous tabs, navigation, consent and faults. Additional focused
tests cover export, restart, partial writes, unsupported markup and delayed
feedback. No live ChatGPT submission, native Keychain test, retained owner kit
change or TestNet transaction is part of these results.
