# Recording services

`runtime.mjs` owns one recording engine and session. Composition supplies platform locking and consent-state persistence, explicit vault custody, and the source registry. The core never starts a browser or invokes a provider Send.

`recording-engine.mjs` orders consent changes and durable acceptance. Source adapters own extraction contracts, source validation, capture tokens and navigation continuity. `source-registry.mjs` binds each connection to an opaque local handle; a transport receives only its own capture and receipt methods. Removing one handle leaves the other peers and the shared vault running. Global OFF revokes every source.

`integration-registry.mjs` stores bounded opt-ins in mutable vault state, separately from immutable signed evidence. Only the existing browser integration inherits its prior configuration; additional integrations begin disabled. Generation changes protect delivery after admission. They do not establish the submission time of vendor-queued hooks that have not started a receiver.

`recording-session.mjs` routes versioned observations through explicit codecs while retaining historical readers, exact-byte storage, bounded receipt lookup and asynchronous anchoring. Chrome, Firefox and coding-hook observations keep distinct source meanings. The browser compatibility entrypoints remain available.

Coding hooks use a bounded synchronous local admission: the native receiver authenticates the resident, which authenticates the enrolled client, decodes the exact hook text, and binds an in-memory copy to the consent generation captured when the connection arrived. Releasing the admitted copy schedules persistence without waiting for it. Timeout, OFF, stale generation, unavailable services or queue pressure cannot grant fresh authority or block the provider. Peer retirement follows enrollment replacement/removal, and hook health keeps only bounded content-free observations.

Mac key custody and peer validation live under `spikes/platform/macos/`. The vault requires an explicitly supplied key store. Platform files and the resident lock remain separate from consent-state interpretation; unsupported native platforms have no fallback that bypasses custody or peer checks.
