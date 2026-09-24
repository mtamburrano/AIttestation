# Long-lived local evidence storage

Schema 4 uses SQLite WAL/FULL transactions and B-trees instead of one encrypted
full-history manifest. No product lifetime record-count or archive-byte ceiling
remains. Portable bundle limits still bound a single export/verification request.
The active page cache is 8 MiB; queries return at most 100 rows, History normally
requests five receipts, and the recording session caches at most 64 observations
and 64 retry aliases. The signed record, object digest, opening, commitment and
signature formats are unchanged.

## Storage and privacy

Each signed record occupies its own encrypted row, keyed by its sequence and
vault-private HMAC locators. Exact evidence is deduplicated by a private HMAC of
its digest. Event IDs, provider message IDs, related-record digests, conversation
identities and search words use separate HMAC domains under a random index key
inside the authenticated header. Disk indexes expose counts, order, equality and
word-frequency patterns, but not prompt text, raw digests, provider IDs or words.
They never leave the local vault or enter managed anchoring.

A small authenticated header holds the chain head, checkpoint, object/byte counts,
History counters and index key. Startup authenticates this header and loads one
recording preference. It does not enumerate records or reconstruct History.
The one-time legacy migration, explicit full verification, explicit index rebuild,
key rotation and full recovery are archive operations, with bounded working sets.
`inspect()` remains an explicit diagnostic full-materialization API, unused by
startup, capture, ordinary views or selective export.

A record append publishes its encrypted object, immutable record, receipt/search
routing and updated header in one transaction. Nonce reservations commit before
that transaction. Interruptions before commit publish none of the new record;
interruptions after commit reconcile by the exact event ID. Text and its signed
prompt descriptor remain two durable records: an orphan text after an interrupted
descriptor write never becomes a saved-prompt receipt. No provider Send is retried.

Schema 4 migrates the bounded schema/v3 index atomically. It retains historical
records and old object ciphertext exactly; subsequent records append to the same
signed chain. Minimum reader 4 prevents an older writer from replacing the new
layout. Pre-migration JSON disclosures and recovery packages remain readable.

## Compression and wrapping keys

Objects of at least 256 bytes are compressed with DEFLATE level 6 only when the
result saves more than 32 bytes. The codec and original length are encrypted and
authenticated. Decompression has that length as its output limit, followed by
exact byte-length and object-digest checks. Signatures and commitments always
refer to the original bytes. Exports disclose those original bytes, including
BOMs, NULs, decomposed Unicode, CRLF and arbitrary binary payloads.

Every encrypted object/record/setting/header gets a fresh random 256-bit DEK.
For `pap-vault-wrap/4`, the wrapping key is
`HMAC-SHA256(VMK, "PAP/wrapping-key/v4\0" || vaultId || "\0" || generation)`,
where `generation = floor(nonceCounter / 65536)`. The 96-bit nonce contains the
64-bit reserved counter in its final eight bytes. SQLite fsyncs reservations in
blocks of 64 before encryption. A generation wraps at most 65,536 DEKs, below the
previous 2^20-per-key encryption budget, and new generations do not require
rewriting old evidence. Exhausting a reservation or crashing burns unused nonces.
Reservation rollback/missing state fails closed; hostile whole-database rollback
remains outside the existing trusted-local-storage assumption.

Legacy direct-VMK wraps retain their original reader and AAD. VMK rotation uses
an indexed, disk-backed staging table, rewraps both old and new DEKs, and switches
all rows/header atomically; it does not change evidence payload ciphertext or
signatures. The app-bound key retirement protocol is unchanged. Small legacy
recovery exports use a fresh package-only VMK with the old wire profile.

## History, search and background work

Dashboard and engine status use five recent logical prompt receipts. Older/newer
navigation uses the last sequence as a keyset cursor, avoiding OFFSET scans.
Private whole-word search is case-insensitive and ANDs up to eight words.
A B-tree lookup supplies candidates from encrypted-word postings; matching
record/receipt data is loaded on demand. Search never decrypts the full archive.
Unicode search tokenization does not normalize the signed payload. Search-word
indexes, counts and grouping can be rebuilt from immutable signed evidence.
Rebuild is explicit and transactional, including interruption rollback.

A pending-anchor B-tree fills at most 32 queue entries per refill. The existing
512 queued/active/scheduled-job and two-worker bounds remain. The cursor excludes
captures whose engine metadata commit has not finished. Missing service
configuration does not start an archive walk. Account, OFF, retry and provider
no-resend rules remain unchanged. Attempt counters overwrite one encrypted state
row per prompt; successful signed submission and proof observations remain durable.

Selective receipt preview/export retrieves selected IDs and their related proof
records, retaining existing bundle limits and preview immutability. A requested
operation with too many related records fails explicitly; it never silently
omits evidence. Duplicate provider-request aliases remain individually retrievable
by exact event/source even after cache eviction.

## Persisted-artifact audit

| Artifact | Classification | Retention / implementation |
| --- | --- | --- |
| Exact prompt/capture bytes and signed text/observation records | Authoritative evidence | Append-only, compressed where useful, content deduplicated; no lifetime count ceiling. |
| Openings, signatures, descriptor/source links, acknowledgements, retry aliases, derivatives | Authoritative evidence | Encrypted immutable record rows; preserve every historical signed byte and original meaning. |
| Public proof objects, managed transaction submissions, fast/consensus observations | Authoritative evidence | Shared proof bytes stored once; retain signed references and independent-verification material. |
| Historical signed engine snapshots, attempt journals and retired release/grant records | Authoritative historical evidence | Retained unchanged and inert. New controls/attempts do not create replacements in evidence history. |
| VMK/signing secrets and managed account credentials | Required durable state | Separate app-bound Keychain roles; service credentials never enter evidence or recovery. |
| `meta`, nonce `usage`, key-retirement intent | Required durable state | Fixed-size authenticated current header; reservation counters and retirement intent preserve cryptographic safety. |
| Object locator/codec/length and encrypted record envelopes | Required durable storage metadata | One metadata row per immutable object/record; authenticated on access. |
| Recording preference and cumulative anchor attempt counts | Required durable state | Encrypted replaceable `settings` rows; preferences excluded from recovery. |
| `engine-recording-off`, legacy `engine-pointer`, resident SQLite lock | Required local control state | Revocation-only fsynced latch; old pointer is read-only migration input; process lock is OS-released. |
| Receipt counts, conversation set, pending/attention, word and record routing indexes | Rebuildable indexes | Updated atomically with evidence; explicit rebuild walks bounded pages. They do not create proof authority. |
| Header/receipt/session caches, command replies, source/epoch tokens | Rebuildable memory state | Fixed working-set/runtime bounds; fresh epochs never restore old capture authority. |
| SQLite WAL/SHM and rotation staging | Transient storage | SQLite checkpoint/reuse; rotation staging is TEMP and disappears on close. WAL is crash recovery, not a second permanent archive. |
| Diagnostic/debug journals, runtime locator, integration/update metadata | Existing bounded local state | Existing content-free retention/permission policies remain. Not copied into evidence recovery. |
| Prepared recovery download | Temporary encrypted owner artifact | One prepared download per server, single-use random URL, 60-second expiry and close cleanup. Process crashes can leave owner-only OS-temporary files. |
| Explicit owner backups and selective disclosures | Owner-selected artifacts | Created only on request; never silently pruned or treated as live indexes. |
| Managed sponsor ledger | External required durable service state | Unchanged, independently scoped; not an evidence-vault cache or part of these tests. |

## Recovery

`pap-recovery-stream/1` is a length-prefixed sequence of independently bounded,
authenticated frames. Each carries a signed record and compressed original object
bytes. A chained authenticated footer binds the full record count/head and detects
missing, reordered, substituted or extra frames. A fresh recovery secret derives
separate frame keys, each used at most 1,024 times. The maximum frame is 64 MiB;
there is no archive-wide memory/count cap. Restore validates the file before
creating a destination, validates again while importing, and checks the final
identity/head. It installs fresh VMK/signing keys and restores recording OFF.
Legacy small JSON packages and the free portable verifier remain compatible.

The Dashboard streams large backups through a single-use local download instead
of embedding the archive in a JSON response. Private backup/restore commands
accept the printed `.pap-recovery` path. Complete means complete at the declared
checkpoint; neither format proves latest state, event truth or complete provider
history. The storage change adds no automatic cloud upload or publication.

## Measurement and validation

Run `node test/vault-scale-benchmark.mjs`. It creates and removes separate temporary
vaults with random test keys, synthetic approximately 1.1 KiB prompts and no
managed services or provider traffic. Each prompt has two real signed records.
Every size runs in a fresh Node child process. Startup includes vault/session/
resident initialization after a close; timings exclude loading Node modules and
OS Keychain/GUI launch. Filesystem caches are warm. RSS includes dataset creation,
cryptography and Node; disk is SQLite after a clean checkpoint. Results are local
measurements, not hardware-independent latency guarantees.

The benchmark compares 4/8/16/32 KiB SQLite pages before the large runs. The 4 KiB
choice retains the smallest page rewrite/read unit and demonstrated bounded
startup, History and search through 50k prompts. Larger pages saved about 4–7%
of disk at 1k; they did not consistently improve reads, and 32 KiB increased
capture time. The fixed 8 MiB cache bounds memory independently of page count.

| Prompts | Startup ms | Recent History ms | Next page ms | Old-word search ms | Common-word search ms | Peak RSS MiB | Disk MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 2.15 | 19.24 | 7.73 | 2.80 | 6.51 | 106.84 | 8.21 |
| 10000 | 2.08 | 17.73 | 7.05 | 2.74 | 7.02 | 156.11 | 81.12 |
| 50000 | 3.26 | 17.46 | 6.30 | 3.85 | 6.17 | 156.67 | 406.41 |

The [measurement file](scaling-benchmark.json) records all raw results, including
the alternative page sizes and capture throughput. Source-level read
counters prove the stronger invariant: all three sizes read one header, zero
records and zero objects during initialization; initial History reads exactly 25
records/40 objects, the next page 15/15, and the oldest-word search 7/7. None grows
with retained history. Search indexes and SQLite B-tree pages grow on disk rather
than entering a full-history JavaScript cache.

Focused regressions cover process death at object/index/commit boundaries,
interrupted legacy migration and rebuild, former 510/511/512 boundaries,
compression/ciphertext corruption, wrapping-key generation rollover, immutable
legacy/streaming recovery and selective export, exact bytes, bounded alias caches,
OFF/ON consent and replay/reconciliation. The isolated real-browser scenario
checks five-row pagination, old-prompt search, disclosure selection and mobile
feedback visibility. No operational vault, Keychain, retained test kit, provider
account or chain ledger is used.
