# Archive

Point-in-time documents moved out of the repository root on 2026-09-04 while
preparing PwndaWallet to be published. Nothing here is load-bearing for a
build; it is kept because it records **why** decisions were made, and deleting
that is how a project loses its reasoning while keeping its code.

| Folder | What is in it |
|---|---|
| `planning/` | Client plans, handoffs and runbooks from the swap-sidecar and fee work, plus the design docs and the RPC audit. Superseded by the wiki where they overlap — treat the wiki as current and these as history. |
| `screenshots/` | Evidence images referenced by bug write-ups and design notes. |
| `misc/` | Scratch files, CSV measurement dumps, and unrelated wiki bootstraps that happened to live at the root. |

**The living documentation is `PwndaWalletVault/`.** Start at
`PwndaWalletVault/index.md`. If something here contradicts the wiki, the wiki
wins — these files are not maintained.

Vendor binaries and archives that were also at the root (the extracted Monero
release, its zip, the Zano archives, the handoff zips — about 424 MB) were
**untracked rather than moved**: every one is reproducible by a pinned,
SHA256-verified fetch script. See
`PwndaWalletVault/wiki/synthesis/shipped-binary-inventory.md` for what each was
and how to get it back.
