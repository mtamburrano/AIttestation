# Historical read-only evidence

Only fixed `testdata/` exports and the original [RESULTS.md](RESULTS.md) remain
here. Their bytes and recorded proof identities are immutable historical
verification vectors. The results describe the historical demonstrator, not the
current ON/OFF product or installed acceptance.

The read-only compatibility helper is
[`recipient/legacy-demo.mjs`](../recipient/legacy-demo.mjs); the standalone
recipient reader also accepts historical exports. Neither reader has signer,
sender, writable journal or sponsorship authority. Old demo executors, composers,
servers, builders and release scripts are removed. Fixed testdata is excluded
from shipping bundles.
