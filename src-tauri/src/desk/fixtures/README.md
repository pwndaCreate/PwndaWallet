# Vendored wire fixtures

`ready_ack_applied.json` / `ready_ack_queued.json` — the desk producer's own
golden `ReadyAck` bodies, read by `desk::wire`'s
`ready_ack_decodes_the_producers_golden_fixtures_c31`.

**Provenance.** Copied verbatim on 2026-09-05 from
`pwnda-desk-handoff/desk-server/internal/api/testdata/wire/`, which was archived
out of this repository the same day (see
`PwndaWalletVault/wiki/synthesis/desk-handoff-archive.md`). Until then the test
reached outside the crate with `include_str!("../../../pwnda-desk-handoff/…")`,
which made a 13 MB agent-handoff tree a compile-time dependency of `cargo test`
for 2 KB of data.

    sha256  87b3dea3f38483427871acd71b5e4b172bb3be005082ece868615f825e1c7479  ready_ack_applied.json
    sha256  15358857c928e9ef434eb2203d11de72463ad79a0f680b8d2c0926a07af3b1dd  ready_ack_queued.json

**These are evidence, not fixtures to edit.** The test exists because a
hand-written body proves only that our decoder matches our own idea of the
wire. If it goes red, the producer's format moved — check that, do not adjust
these bytes to make the test pass.
