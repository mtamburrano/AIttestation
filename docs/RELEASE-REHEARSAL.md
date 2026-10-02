# Offline upgrade and recovery rehearsal

```sh
npm run test:release-rehearsal
# Retain a report at an explicit fresh location:
npm run test:release-rehearsal -- --output /absolute/new-rehearsal-report
```

This extends the existing product runner. It allocates fresh temporary accounts,
memory keys, vaults and integration directories; strips inherited application and
credential settings; disables the sponsor; and removes fixtures after the run.
The bounded `result.json`, `diagnostics.json` and `report.html` remain. The report
contains named checks and reproduction commands, not prompt text, keys or files.
Each group has a 60-second limit and the parent runner has a 180-second limit.
Local sockets must be permitted. No vendor app, network service or Keychain is used.

| Scenario | Checks through current product components |
| --- | --- |
| `release-migration` | Synthetic schema 1 and 3 predecessors; process death after DDL, before commit and after commit; compatible reopen; byte-identical disclosure; rejection by incompatible readers |
| `release-update-authority` | Ephemeral Ed25519 metadata signatures; stale sequence, schema and signature rejection; interrupted, altered and oversized downloads; injected Apple-verification rejection; current app remains usable |
| `release-recovery-removal` | JSON and streaming recovery; interruptions before/after commit; exact records and exports; fresh keys; restored OFF; stale runtime authority rejection; new-sequence forward repair; removal retains evidence and independently copied verifier access |

To reproduce one group, use
`npm run test:product -- --scenario release-recovery-removal` (substitute any name
above). For detailed local failure output, run the tests named by
`spikes/development/release-fixtures.mjs` with its finite name filter. Those are the
existing distribution/key-lifecycle tests plus the recovery/removal integration
test; there is no second updater or migrator.

All predecessors are **synthetic local fixtures**, not historical shipped releases.
Release signatures use ephemeral test keys; Apple verification is injected. These
checks establish no Developer ID, notarization, installed-client, provider or
production update-server evidence. The distribution artifact verifier remains a
separate readiness gate. It must validate an actual candidate's exact bytes before
any later owner-authorized release.

Do not bypass the rollback floor or edit schema metadata to downgrade an installed
vault. A repair release needs a new sequence and a compatible reader. Recovery
restores evidence under fresh keys with recording OFF; consent, source sessions
and old Send authority are not restored. The standalone free verifier remains
usable independently of the application and managed services.
