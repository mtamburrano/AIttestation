# Distribution dependency inspection

The packaging code adds no third-party JavaScript dependency. Node is a bundled
runtime, so its embedded components remain dependencies. The generated inventory
records the exact Node binary digest, runtime version, embedded versions and all
direct/indirect Go pins with go.sum checksums. Updating any of them requires a new
security/license approval for that exact inventory. This source inspection is
not a current vulnerability audit or release approval.

| Component | Pin | Boundary / inspection |
| --- | --- | --- |
| Node | Binary-specific inventory; inspected runtime v22.23.1 | Local app, HTTP and SQLite; bundled Node-LICENSE.txt includes component notices; requires a patched release binary as described below |
| go-algorand-sdk/v2 | v2.12.0 | Transaction/proof encoding and decoding; module MIT notice retained |
| go-stateproof-verification | v1.0.0 | Archival proof verification; module MIT notice retained |
| avm-abi | v0.2.0 | SDK dependency; module MIT notice retained |
| falcon | v0.0.0-20220727072124-02a2a64c4414 | Native proof crypto; module-wide MIT notice in the pinned README.txt, including the deterministic implementation; notice and attribution retained |
| go-codec/codec | v1.1.10 | MessagePack hostile-input boundary; module MIT notice retained |
| go-sumhash | v1.0.0 | Proof hashing; module MIT notice retained |
| go-querystring | v1.1.0 | SDK dependency; module BSD notice retained |
| x/crypto | v0.52.0 | Crypto dependency; security update from v0.45.0; module BSD notice retained |
| x/sys | v0.45.0 | Native/system interfaces; required by x/crypto v0.52.0; module BSD notice retained |
| Swift, Go, macOS system libraries | Recorded/checked by release build | Toolchains and system trust remain explicit assumptions; verify current notices/advisories at release |

The builder verifies Mach-O executables depend only on macOS system dylibs, and
rebuilds the shipping native tools before signing. The recipient excludes the
vault, Keychain helper, account client, sponsorship executable and network observer.
No install hooks or package-manager setup run on the consumer's Mac.

The x/crypto and x/sys pins retain the Go 1.25.1 language baseline; their upstream
go.mod files require Go 1.25.0. Regenerate the inventory after updating go.mod,
go.sum or notices. The inventory binds the selected module versions and checksums,
both dependency-file digests, notices, the Node binary and its embedded versions,
and the explicitly selected Go executable. An inventory or approval from the
previous graph cannot cover this graph. The generated inventory is not an
approval, and a module advisory lookup does not cover the bundled runtimes.

Falcon's [README.txt at the exact pinned commit](https://github.com/algorand/falcon/blob/02a2a64c44147775e6870b2d957f2cfda1437895/README.txt)
licenses the implementation under MIT, with Copyright (c) 2017-2020 Falcon Project,
and credits David Lazar for the deterministic mode. Its complete notice and
attribution are reproduced in THIRD_PARTY_NOTICES.md.

The inspected Node v22.23.1 binary predates the
[July 2026 Node security release](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases),
which supplies v22.23.2 with high-severity fixes and embedded dependency updates.
Go 1.25.1 also predates multiple standard-library security fixes, and the Go 1.25
line is outside the [Go release support policy](https://go.dev/doc/devel/release)
after Go 1.27's release. These local tools can establish compatibility but must
not receive release security approval. Select supported, patched release tools,
regenerate their exact inventory, confirm compiler/runtime notices are included,
and review Node's embedded components, C/Go proof parsing and platform assumptions
before providing the external approval described in the support runbook.
Successful hash matching does not establish security or license approval.
