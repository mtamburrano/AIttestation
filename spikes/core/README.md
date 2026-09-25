# Recording services

`runtime.mjs` owns one recording engine and session. Composition supplies platform locking and consent-state persistence, explicit vault custody, and the source registry. The core never starts a browser or invokes a provider Send.

`recording-engine.mjs` orders consent changes and durable acceptance. Source adapters own extraction contracts, source validation, capture tokens and navigation continuity. `source-registry.mjs` binds each connection to an opaque local handle; a transport receives only its own capture and receipt methods. Removing one handle leaves the other peers and the shared vault running. Global OFF revokes every source.

`integration-registry.mjs` stores bounded opt-ins in mutable vault state, separately from immutable signed evidence. Only the existing browser integration inherits its prior configuration; additional integrations begin disabled. Generation changes protect delivery after admission. They do not establish the submission time of vendor-queued hooks that have not started a receiver.

`recording-session.mjs` retains the existing versioned observation readers, exact-byte storage, bounded receipt lookup and asynchronous anchoring. The browser compatibility entrypoints remain available. This extraction adds no new signed observation profile. Codex, Claude Code and Firefox capture are not enabled by the extraction.

Mac key custody and peer validation live under `spikes/platform/macos/`. The vault requires an explicitly supplied key store. Platform files and the resident lock remain separate from consent-state interpretation; unsupported native platforms have no fallback that bypasses custody or peer checks.
