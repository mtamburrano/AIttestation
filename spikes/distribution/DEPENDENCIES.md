# Distribution dependency inspection

The packaging code adds no third-party JavaScript dependency. Node is a bundled
runtime, so its embedded components remain dependencies. The generated inventory
records the exact Node binary digest, runtime version, embedded versions and all
direct/indirect Go pins with go.sum checksums. Updating any of them requires a new
security/license approval for that exact inventory. This source inspection is
not a current vulnerability audit or release approval.

| Component | Pin | Boundary / inspection |
| --- | --- | --- |
| Node | Binary-specific inventory; inspected runtime v22.23.1 | Local app, HTTP and SQLite; bundled Node-LICENSE.txt includes component notices |
| go-algorand-sdk/v2 | v2.12.0 | Transaction/proof encoding and decoding; module MIT notice retained |
| go-stateproof-verification | v1.0.0 | Archival proof verification; module MIT notice retained |
| avm-abi | v0.2.0 | SDK dependency; module MIT notice retained |
| falcon | v0.0.0-20220727072124-02a2a64c4414 | Native proof crypto; upstream source MIT notices found, deterministic-wrapper/module-wide license coverage unresolved |
| go-codec/codec | v1.1.10 | MessagePack hostile-input boundary; module MIT notice retained |
| go-sumhash | v1.0.0 | Proof hashing; module MIT notice retained |
| go-querystring | v1.1.0 | SDK dependency; module BSD notice retained |
| x/crypto | v0.45.0 | Crypto dependency; module BSD notice retained |
| x/sys | v0.38.0 | Native/system interfaces; module BSD notice retained |
| Swift, Go, macOS system libraries | Recorded/checked by release build | Toolchains and system trust remain explicit assumptions; verify current notices/advisories at release |

The builder verifies Mach-O executables depend only on macOS system dylibs, and
rebuilds the shipping native tools before signing. The recipient excludes the
vault, Keychain helper, account client, sponsorship executable and network observer.
No install hooks or package-manager setup run on the consumer's Mac.

Before approving distribution, resolve the Falcon wrapper notice gap and confirm
the selected Go toolchain/runtime notices are included. Review the exact embedded
Node components, C/Go proof parser and platform assumptions, then provide the
external approval described in the support runbook. Keep that review separate
from the generated inventory; successful hash matching does not mean a component
is secure or licensed for a particular distribution.
