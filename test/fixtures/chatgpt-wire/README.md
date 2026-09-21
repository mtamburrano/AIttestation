# ChatGPT request fixtures

These four JSON bodies preserve actual requests captured by the owner from a
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
