# Publication license policy

Attestamp's selected public license model is:

| Material | Selected license |
| --- | --- |
| Protocol prose and normative documentation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode.en) |
| Standalone verifier, trust-critical local core and browser admission bridge | [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) |
| Third-party components | Their existing notices and licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) |

Trust-critical scope includes exact-byte observation/admission, consent policy,
IPC validation, signing and key handling, vault encryption/recovery, and proof
generation/verification. Frozen protocol names and cryptographic domains remain
unchanged. Export and verification remain independent of managed services.

This records the selected policy; it does not silently license the entire mixed
repository. Before public distribution, the owner must confirm the per-file scope,
contributor/IP rights, attach the corresponding license/notice and source-offer
artifacts, and approve the exact dependency inventory. Consumer shell/UI files
without trust semantics, hosted services, account/billing, distribution/update
infrastructure and maintenance tooling may remain proprietary. Their disposition
is unresolved, not an implied open-source grant. There are no field-of-use or
commercial-use restrictions to be added to material described as open source.

The Attestamp name and branding are separate from code licensing; public launch
also needs the existing ownership/brand review. No legal-evidence or universal
security certification is claimed by this repository.
