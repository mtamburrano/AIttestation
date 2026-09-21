# ChatGPT request fixtures

The four `*-text`, `*-image` and `*-file` JSON bodies preserve actual requests captured by the owner from a
dedicated test account on 2026-09-21. They are permanent offline regressions for
`POST /backend-api/f/conversation`, covering new-chat text, existing-chat text,
text with an image, and text with an RTF document.

All object keys, array ordering, primitive types, absent fields, operation values,
content types, upload attribution, response contracts and feature/configuration
fields are retained. Message/conversation/parent/file/library IDs, asset IDs,
creation times, filenames, sizes, dimensions, locale/display measurements and the
identifying prompt markers are replaced with deterministic synthetic values.
The image pointer still references its sanitized attachment ID. No attachment
bytes, headers, cookies or credentials are included. The raw corpus is not stored
in this repository. The provider `client-created-root` sentinel, `sediment://`
scheme, `photo_upload_action.v1` capabilities and `manual_send` value are preserved.

`test/chatgpt-wire-robustness.test.mjs` exercises each body through extraction,
the shipped observer/relay, authenticated worker/engine, encrypted storage and
portable verification under both new-chat and conversation routes. It asserts
exact text, both identities, unsupported attachment evidence, unchanged provider
fetch and additive unknown metadata. Synthetic perturbations are kept in tests;
the four fixtures themselves retain their observed structure.

The baseline regression is stage-specific. On `82d6473`, standalone extraction
accepts the text-only bodies. The new-chat text body fails in the observer under
an authenticated conversation route because its absent provider conversation ID
is compared to the route ID. A different non-empty provider ID fails at the same
check. Image and document bodies fail extraction. See
[the baseline comparison](../../evidence/request-wire-baseline.json) for the
fixture and source hashes, positive controls and exact observed outcomes.

This corpus grounds request parsing in observed wire shapes. Offline replay and
synthetic Chrome tests do not establish live installed capture or owner acceptance.

`steer-turn.json` is a reduced fixture derived from the owner's recorded live
steering request and the exact Request URL confirmed on 2026-09-22:
`POST https://chatgpt.com/backend-api/f/steer_turn`. It retains the reported
`action: "next"`, system-entry/user-entry ordering, explicit user role, text
parts, fresh message identity, conversation and parent identity, serialization
metadata and `submission_mode: "manual_send"`. Text and IDs are synthetic;
serialization metadata is an empty placeholder. Unreported system content and
additive model/client/chime/turn-exchange values are omitted. Unlike the four
full bodies above, this is an owner-derived projection, not a verbatim sanitized
copy of the entire wire body.

`test/chatgpt-steering.test.mjs` exercises this projection through the full
capture and portable-verification path while an assistant stream stays open.
It also covers exact UTF-8, operation exclusions, message-ID deduplication,
multitab attribution, OFF/ON stale delivery and unchanged fetch semantics.
The [steering baseline comparison](../../evidence/steering-baseline.json) shows
that `8a7460a` does not match this endpoint, while the identical body on the
ordinary conversation endpoint is a passing control. The current observer
captures both without changing the original fetch call.
