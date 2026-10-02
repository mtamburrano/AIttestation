# Third-party notices

The maintained [distribution notices](spikes/distribution/THIRD_PARTY_NOTICES.md)
contain the existing Node/V8, Go and pinned module attributions. Each built app
also carries the exact selected Node distribution's `Node-LICENSE.txt`.
The vendored [smol-toml license](spikes/coding/vendor/smol-toml/LICENSE) and
[provenance manifest](spikes/coding/vendor/smol-toml/provenance.json) pin its version,
license, source tarball and file hashes.

[Dependency review notes](spikes/distribution/DEPENDENCIES.md) are historical,
version-scoped evidence; they are not current vulnerability clearance. Reassess
the exact shipping inputs before distribution. Inventory generation and preserved
notices do not replace license/security approval. The repository's own selected
licensing boundaries are described in [LICENSE.md](LICENSE.md).
