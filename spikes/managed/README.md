# Managed anchoring

This bounded service sponsors Algorand TestNet self-payments from an operator-owned
account. Consumers connect an anchoring account in the local dashboard using
an access code; they never create a crypto wallet, handle a seed, or sign a network
transaction. The app keeps the access code in a separate app-bound Keychain item,
scoped to the configured service origin. Signing out removes only that credential.
Evidence keys, recovery and exports do not depend on it.

## Consumer behavior

A durable new observation queues an asynchronous sponsorship attempt. The runtime constructs a
single-leaf Merkle root over the locally signed, blinded observation record and
sends only canonical `{"payload":"…","profile":"pap-managed-anchor/1"}`. The payload
is exactly `PAP || 0x01 || root_sha256` (36 bytes, base64url). Neither record digest,
content digest, opening, text, filename, scope, signing key nor decryption key is
included. The account bearer code is sent only in the Authorization header to the
fixed HTTPS origin. HTTP redirects are rejected; response size and duration are
bounded. No page or remote response can choose a destination URL or read a vault.

The service can observe account identity, IP/timing/volume, blinded payloads and
their public transaction IDs. The sponsor address and notes are public on-chain.
It cannot establish whether an arbitrary authenticated client supplied a properly
blinded root; the official client enforces construction locally. Strict schema
validation excludes extra fields but is not a cryptographic proof of blinding.

Sponsorship is only submission. The existing local fast-confirmation verifier
still requires two separately configured independent operators and exact payload
inclusion. The managed origin cannot be either observer. A service reply, active
subscription, or transaction ID alone never establishes anchor assurance.

| Condition | Recording behavior |
| --- | --- |
| No account, outage, timeout or exhausted allowance | Durable local evidence remains; anchor stays pending |
| Unpaid/expired account | Capture, receipts, recovery, export and verification remain free |
| Submitted transaction with missing/conflicting confirmation | Pending assurance; never infer proof from its ID |
| Lost response or interrupted submission | Reuse the same blinded payload and ledger reservation; never sign a replacement |
| Expired saved transaction | Bounded observation can fail; no automatic replacement or fee refund |
| Recording OFF | Stop new capture; bounded work for already-durable evidence may finish |

Each observation has at most three persisted client anchor attempts across restarts,
committed before external work. An unconfigured client or missing local credential
uses none of this budget. The client's synchronous `beforeSubmit` hook runs after
payload/credential checks and before the request; failure to persist the attempt
prevents submission. Remote rejection and ambiguous submission still consume an
attempt. At most two jobs run concurrently within a queue of 512; each runtime
considers eligible durable observations once, filling freed slots from history.
Queue saturation leaves local saves PENDING and does not block evidence capture.
Saved transaction IDs
are reused without a new sponsor request and can still be observed after account
disconnect. A renewed/recovered credential retains the same account and quotas.
The service can return an existing reservation after expiry within request limits.
No failure changes the user's provider Send or backfills an unobserved prompt.
Historical observation profiles remain read-only and do not enter new anchor work.

## Bounds and durable accounting

Defaults: 1,000 accounts; 1,000 new anchors/account/UTC month; 100/account/UTC day;
10,000/service/UTC day; 20 authenticated requests/account/minute; 600 total service
requests/minute at authentication. Invalid tokens consume the global request
budget. Quotas are shared by all credentials for an account, persist in SQLite,
and cannot reset through renewal, code rotation, process restart or clock rollback.
Daily limits apply to reservations, including failed preparations.

The ledger stops accepting new reservations at 100,000 rows. It retains
idempotency records rather than silently pruning them and risking duplicate fees.
Capacity/policy changes require an explicit operator migration; startup rejects a
different configured policy. The reverse proxy should also bound incoming traffic;
the application bounds headers, request bodies (256 bytes), connections (32),
active handlers (16), and timeouts. It exposes only account status and anchoring,
with no public signup, payment mutation, arbitrary signing or transaction API.

A SQLite `BEGIN IMMEDIATE` transaction atomically checks limits and reserves quota.
Preparation cannot broadcast. Signed bytes are durably saved before a separate
broadcast operation; subsequent attempts reuse those exact bytes and transaction
ID. At most three broadcasts are attempted, at least 10 seconds apart, with the
counter committed before each attempt. Ambiguous network outcomes never refund a
reservation or cause a fresh transaction to be signed. Interrupted preparation is
conservatively charged and cannot be repeated for the same payload.

The fixed-purpose Go helper accepts only the pinned TestNet/genesis/consensus, a
zero-value self-payment, a 36-byte note, a 20-round validity interval and exactly
1,000 microALGO fee. Reconstruction before broadcast excludes transfer, close,
rekey, grouping and arbitrary-signing authority. Higher required fees fail closed.
At default limits the reserved fee bound is 1 ALGO/account/month and 10 ALGO/service/day;
these are accounting bounds, not an exchange-rate or euro-cost claim. See the
[Algorand fee reference](https://dev.algorand.co/concepts/transactions/fees/).

## Operator setup

No service is deployed or funded by the default build. Production billing,
MainNet, public signup and managed evidence/cloud backup are outside this slice.
The account administration commands are the minimal trusted subscription boundary;
an operator provisions, renews or revokes paid-through time after checking payment
out of band. There is no client-supplied entitlement, public billing callback or
automatic payment-provider integration. Account recovery rotates the access code
after an operator verifies the customer; it does not recover evidence keys.

Build the Go tools with `make -C spikes/anchor/algorand build`. Use a fresh dedicated
TestNet sponsor funded only with free faucet ALGO. Keep its 32-byte raw seed in an
owner-only regular file outside all repositories. The helper rejects aliases and
requires the expected public sponsor address. Never configure an existing personal
account or MainNet funds.

Create a canonical JSON configuration outside the repository (keys in this order):

```json
{"directory":"/absolute/private/service-data","expectedAddress":"DEDICATED_TESTNET_PUBLIC_ADDRESS","network":"testnet-v1.0","port":8787,"seedPath":"/absolute/private/sponsor.seed"}
```

Operator commands (configuration path and targets must be explicit):

```sh
node spikes/managed/main.mjs /absolute/service-config.json provision 2026-12-01T00:00:00Z
node spikes/managed/main.mjs /absolute/service-config.json renew ACCOUNT_ID 2027-01-01T00:00:00Z
node spikes/managed/main.mjs /absolute/service-config.json rotate ACCOUNT_ID
node spikes/managed/main.mjs /absolute/service-config.json serve
```

Provision/rotate print the new access code once for secure account delivery.
Renewing to a past date stops new sponsorship without deleting history. These
commands have local administrative authority and are not HTTP endpoints.

Serve behind a TLS reverse proxy on a dedicated HTTPS origin. The process binds
only `127.0.0.1`; preserve Authorization and content length, disable request/body
and credential logging, and do not add evidence or credential telemetry. Proxy
and service limits must remain explicit. Back up the ledger before operational
maintenance; restoring an obsolete ledger loses quota/idempotency history and must
not be used to resume the same sponsor automatically.

Set `spikes/browser/chatgpt/managed-config.json` to canonical
`{"origin":"https://YOUR_MANAGED_ORIGIN"}` before signing the consumer build. Null
means unavailable and preserves all local features. The signed app bundles only
the managed client/protocol, never the sponsor executable or service database.
Service URL and network configuration are operator/build choices, not page inputs.

## Verification

`node --test test/managed-sponsorship.test.mjs test/chatgpt-browser-path.test.mjs`
uses new temporary databases/vaults, memory credentials, loopback HTTP and injected
synthetic sponsor/observer transports. `go test ./cmd/sponsor` in the Algorand module
uses fresh in-memory accounts and a fake HTTP RoundTripper, with no network access
or funds. Default tests never run operator commands, access the real Keychain,
submit a live transaction or contact a billing system.
