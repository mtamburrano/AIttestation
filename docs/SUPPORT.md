# Supported scope and evidence limits

| Surface | Current implementation and validation boundary |
| --- | --- |
| Apple-silicon macOS 15.7+ / Chrome / ChatGPT Web | Privately accepted baseline; current adapter targets Chrome Stable major 154 and supported text requests |
| Firefox / ChatGPT Web on Mac | Shared implementation and isolated browser evidence; persistent signed add-on and installed distribution chain remain separate gates |
| Local Codex desktop, active VS Code extension, CLI | Explicit executable enrollment and deterministic/native fixture coverage; each vendor surface's hook trust and actual emission need installed evidence |
| Local Claude Code | Explicit single executable enrollment and deterministic/native fixture coverage; actual vendor hook/subscription availability is separate |
| Free export and verifier | Local/offline path independent of managed services; historical records retain versioned semantics |
| Windows/Linux, other browsers/providers, remote/cloud/container clients | Not delivered or validated product support |

Discovery means a bounded local installation was found. Configured means owned
settings are present. Enabled means that integration may join global ON recording.
Trust, restart and successful durable capture are separate states. No Store install
or signing is implied by an available local setup button.

Browser capture supports the declared new-user request text projection up to
256 KiB. Coding capture records the documented submission-hook prompt field.
Neither reconstructs hidden context, attachments, replies, voice, complete history
or provider-internal requests. Unsupported shapes, connection failures and storage
limits can leave gaps. There are no authorship, ownership, provider-receipt,
complete-history, event-truth, non-retention or pre-egress claims.

Published fixture results establish only their exact revision and synthetic scope.
Native ad-hoc signatures do not establish Developer ID/notarization. Temporary
Firefox installation does not prove persistent Mozilla signing. No public Store
release, service deployment or production availability is promised.
