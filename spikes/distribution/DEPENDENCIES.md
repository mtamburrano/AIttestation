# Distribution dependency inspection

The packaging code adds no third-party JavaScript dependency. Node is a bundled
runtime, so its embedded components remain dependencies. The generated inventory
records the exact Node binary digest, runtime version, embedded versions and all
direct/indirect Go pins with go.sum checksums. Updating any of them requires a new
security/license approval for that exact inventory. The findings below support
an operator's review; they do not replace independent release approval.

| Component | Pin | Boundary / inspection |
| --- | --- | --- |
| Node | Binary-specific inventory; release baseline v24.21.0 | Local app, HTTP and SQLite; bundled Node-LICENSE.txt and supplemental V8 notices are bound to the inventory |
| go-algorand-sdk/v2 | v2.12.0 | Transaction/proof encoding and decoding; module MIT notice retained |
| go-stateproof-verification | v1.0.0 | Archival proof verification; module MIT notice retained |
| avm-abi | v0.2.0 | SDK dependency; module MIT notice retained |
| falcon | v0.0.0-20220727072124-02a2a64c4414 | Native proof crypto; module-wide MIT notice in the pinned README.txt, including the deterministic implementation; notice and attribution retained |
| go-codec/codec | v1.1.10 | MessagePack hostile-input boundary; module MIT notice retained |
| go-sumhash | v1.0.0 | Proof hashing; module MIT notice retained |
| go-querystring | v1.1.0 | SDK dependency; module BSD notice retained |
| x/crypto | v0.52.0 | Crypto dependency; security update from v0.45.0; module BSD notice retained |
| x/sys | v0.45.0 | Native/system interfaces; required by x/crypto v0.52.0; module BSD notice retained |
| Go | Release compiler go1.27.1 darwin/arm64 | Runtime/compiler identity, root LICENSE and PATENTS are bound to the inventory; Go Authors and supplemental standard-library notices are retained |
| Swift, macOS system libraries | Recorded/checked by release build | Platform toolchains and system trust remain explicit assumptions; verify current notices/advisories at release |

The builder verifies Mach-O executables depend only on macOS system dylibs, and
rebuilds the shipping native tools before signing. The recipient excludes the
vault, Keychain helper, account client, sponsorship executable and network observer.
No install hooks or package-manager setup run on the consumer's Mac.

The x/crypto and x/sys pins retain the Go 1.25.1 language baseline; their upstream
go.mod files require Go 1.25.0. Regenerate the inventory after updating go.mod,
go.sum or notices. The inventory binds the selected module versions and checksums,
both dependency-file digests, notices, the Node binary and its embedded versions,
the copied Node LICENSE, and the explicitly selected Go executable plus its
GOROOT LICENSE/PATENTS. Missing notice files reject inventory generation.
An inventory or approval from the
previous graph cannot cover this graph. The generated inventory is not an
approval, and a module advisory lookup does not cover the bundled runtimes.

Falcon's [README.txt at the exact pinned commit](https://github.com/algorand/falcon/blob/02a2a64c44147775e6870b2d957f2cfda1437895/README.txt)
licenses the implementation under MIT, with Copyright (c) 2017-2020 Falcon Project,
and credits David Lazar for the deterministic mode. Its complete notice and
attribution are reproduced in THIRD_PARTY_NOTICES.md.

## Advisory findings for the release baseline

Checked 2026-09-12. [Node 24.21.0](https://nodejs.org/en/blog/release/v24.21.0)
is the selected LTS runtime, including OpenSSL 3.5.8, Undici 7.29.1,
V8 13.6.233.17-node.53, SQLite 3.53.4, c-ares 1.34.8, llhttp 9.4.3 and
libuv 1.52.1. It includes the
[July Node security release](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases)
and the subsequent OpenSSL/Undici fixes. OpenSSL 3.5.8 is outside the affected
ranges in the [August advisories](https://openssl-library.org/news/vulnerabilities/index.html).
Undici 7.29.1 fixes the September
[WebSocket crash](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v),
[TLS option loss](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3),
and [decompression](https://github.com/nodejs/undici/security/advisories/GHSA-3xpg-4rpp-hhhm)
advisories. SQLite's [3.53.4 release](https://sqlite.org/changes.html) and the
[c-ares 1.34.8 changelog](https://c-ares.org/changelog.html) were also checked.
The published [nghttp2 advisories](https://github.com/nghttp2/nghttp2/security/advisories)
are fixed by the embedded 1.70.0; the c-ares 1.34.7 security fixes are present
in 1.34.8. The installed Node binary/license and Go driver/compiler/linker match
the provisioned archives, whose hashes match the publishers' HTTPS checksum
lists. This is an HTTPS/source-integrity check, not a verification of release
signatures or a reproducible-build attestation.

The [Go vulnerability database](https://go.dev/doc/security/vuln/database)
snapshot modified 2026-09-10T14:48:42Z lists no unresolved affected range for
Go 1.27.1's standard library/toolchain or x/sys v0.45.0. The Go 1.27 line is
supported under the [release policy](https://go.dev/doc/devel/release).
A GitHub lookup reported no advisories for the nine exact module pins, but the
Go database has four relevant module-level findings for x/crypto v0.52.0:

| Advisory | Affected package | Disposition for the shipping tools |
| --- | --- | --- |
| [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932) | openpgp and its subpackages; no fixed version | Not imported |
| [GO-2026-6303](https://pkg.go.dev/vuln/GO-2026-6303) | ssh; fixed in v0.55.0 | Not imported |
| [GO-2026-6354](https://pkg.go.dev/vuln/GO-2026-6354) | ssh; fixed in v0.56.0 | Not imported |
| [GO-2026-6355](https://pkg.go.dev/vuln/GO-2026-6355) | ssh; fixed in v0.56.0 | Not imported |

The offline `go list -deps` closure for `cmd/verify`, `cmd/fastverify` and
`cmd/fastobserve` includes only `x/crypto/ed25519` and `x/crypto/sha3` from that
module. This supports a package-absence finding, not a claim that the entire
module is vulnerability-free. Preserve the nine selected pins; re-evaluate
advisory applicability whenever imports, build flags or supported platforms change.
Eight modules occur in the shipping package closure; the inventory also retains
the declared avm-abi pin. `go list -m all` needs additional non-shipping module
metadata that is not present in the designated offline release cache; it is not
used as evidence of the shipping closure.

## Notice coverage and approval

The complete Node LICENSE is copied into both apps. Its MIT/BSD/ISC,
Apache-2.0, ICU and zlib-family notices remain intact; SQLite's deliverable
library is [public domain](https://sqlite.org/copyright.html). The supplemental
V8 Strongtalk and fdlibm notices are included in THIRD_PARTY_NOTICES.md. The
Go Authors BSD terms already retained there also cover the Go runtime and
vendored standard-library packages. Sun/Cephes math and fiat-crypto attributions
from Go 1.27.1 are included explicitly. The build does not enable BoringCrypto
or distribute the Go compiler, npm, Corepack or Node development/test tools.

No operator approval file is supplied. An independent reviewer must assess the
exact inventory, package-absence findings and notice coverage before issuing
the security/license assertion described in the support runbook. Inventory
hashes identify inputs; they do not establish security or grant license rights.
The former Node v22.23.1 / Go 1.25.1 runtime baseline remains unsuitable for
release approval; the go.mod language directive is not the selected compiler.
