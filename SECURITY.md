# Security policy

## Reporting a vulnerability

Report it privately. Open this repository's **Security** tab and choose **Report a
vulnerability**; if that option is not offered, email pwndamining@protonmail.com. Please do not
open a public issue for a security problem.

Please include enough to reproduce it: the version you are running, your platform, and the steps.
If it can lose funds or expose a seed phrase or a private key, say so in the subject so it is read
first.

This is a one-person project, so please allow a reasonable window before public disclosure.
Expect an acknowledgement within a few days. There is no bounty program.

## Scope

In scope: the code in this repository, and the installers and packages published on its Releases
page and package repository (the Windows installer, and the Linux `.deb`, `.rpm` and AppImage).

The wallet is non-custodial. Keys are generated and kept on your machine, the vault is encrypted
with PBKDF2 and AES-GCM, and nothing in the project can move your funds or recover a lost seed.
Reports about key and seed handling, the vault, transaction signing, the atomic-swap refund paths,
and the update channel matter most.

Out of scope: the projects the wallet builds on or bundles (BasicSwap, the coin daemons, the
miners; please report those to their maintainers), the pool and website services at pwnda.org
(those are covered by the policy in the
[PwndaServer](https://github.com/pwndaCreate/PwndaServer/blob/main/SECURITY.md) repository), and
denial of service by sheer traffic volume against public endpoints.

## Supported versions

Fixes ship in a new release; the in-app updater and the Linux package repository deliver it. Older
versions are not patched separately. Every release asset carries a detached signature that the
updater verifies before installing.
