#!/usr/bin/env node
// scripts/fetch-swap-runtime.mjs
//
// Fetch + verify + stage every pinned input the BasicSwap swap sidecar runtime
// is built from. Sibling of scripts/fetch-sidecars.mjs (wallet-rpc sidecars) and
// scripts/fetch-miners.mjs; same conventions — pin table, sha256 verify, abort
// on mismatch, cache dir, --check mode, manifest emission.
//
// WHY THIS EXISTS
//   The runtime at .swap-sidecar-work/runtime was hand-built once. Everything it
//   is made of has to be re-derivable from pins, or the next machine gets a
//   different runtime and nobody can tell.
//
// WHY IT ALSO REPLACES UPSTREAM'S CORE VERIFICATION (this is the load-bearing bit)
//   basicswap.bin.prepare downloads the coin daemons itself and verifies them with
//   GPG via python-gnupg, which resolves `gpg` from PATH only. On Windows the only
//   gpg.exe around is Git's MSYS2 build, and it CANNOT take Windows paths — the
//   homedir/keyring arguments prepare hands it are rejected (defect U-2). The
//   documented escape hatch, SKIP_GPG_VALIDATION=true, leaves prepare fetching
//   binaries over the network with only a SHA256-manifest check.
//
//   So production does not use upstream's fetch path at all:
//     1. THIS script fetches each coin release and verifies it against a sha256
//        pinned here (each pin cross-checked below against the upstream signed
//        gitian/guix build-assert manifest at the time it was recorded).
//     2. It extracts the daemons into <out>/cores/<coin>/.
//     3. The supervisor invokes prepare with `--nocores --bindir=<that dir>`, so
//        upstream never downloads and never verifies anything.
//   The trust anchor moves from "gpg.exe works on Windows" (it does not) to "this
//   pin table" (it does, and it is reviewable in a diff).
//
// USAGE
//   node scripts/fetch-swap-runtime.mjs --check       # HEAD-only reachability +
//                                                     # print pins; no big downloads
//   node scripts/fetch-swap-runtime.mjs               # full fetch + verify + stage
//   node scripts/fetch-swap-runtime.mjs --out=DIR     # stage somewhere else
//   node scripts/fetch-swap-runtime.mjs --cache=DIR   # download cache
//   node scripts/fetch-swap-runtime.mjs --wheelhouse=DIR
//                                                     # where the two LOCALLY BUILT
//                                                     # wheels are picked up from
//   node scripts/fetch-swap-runtime.mjs --force       # ignore the cache, refetch
//
// WHAT IT STAGES (all under --out, default .swap-sidecar-work/swap-runtime-stage)
//   python/  <cpython archive>                  win: python.org embeddable zip
//                                              linux: python-build-standalone tar.gz
//   wheels/  9 wheels                           7 from PyPI + 2 built locally
//   sources/ coincurve-basicswap_v0.4.zip       build input for the fork wheel
//   cores/   particl/ litecoin/ monero/ zephyr/ extracted daemons for --bindir
//                                              (zano pending — see ZANO_CORE_PLACEHOLDER,
//                                               filled by Grove expansion unit A5)
//   swap-runtime.json                           the manifest
//
// WHAT IT DOES NOT DO — read this before believing the runtime is one command away
//   It does not ASSEMBLE the runtime image (unpack CPython, edit python312._pth on win,
//   install the wheels, strip pip/Scripts/__pycache__). That needs an external
//   python with pip — the shipped runtime deliberately has none — and it is a
//   separate, already-documented step; see .swap-sidecar-work/runtime/
//   RUNTIME-MANIFEST.json and the `assembly` block this script writes into
//   swap-runtime.json. This script's job is: every input, pinned and verified.
//
//   It does not BUILD the two local wheels either. coincurve needs MSVC + CMake;
//   basicswap needs hatchling. Both are picked up from --wheelhouse and checked
//   against a pinned ARTIFACT hash. Neither build is bit-reproducible (see
//   NOT_REPRODUCIBLE below), which is exactly why the artifact is pinned and not
//   the build.
//
// MANIFEST INTEGRITY
//   swap-runtime.json carries a treeHash over every staged artifact using the
//   ENGINE-TREE.json scheme `sha256-of-sorted-sha256-lines-v1`, with both of that
//   spec's documented footguns restated in the manifest itself: the TWO-SPACE
//   separator (sha256sum prints " *" in binary mode, which Git Bash on Windows
//   defaults to) and the LC_ALL=C bytewise sort.

import { mkdir, writeFile, readFile, rm, stat, readdir, copyFile } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DISTRO_NAME, groveId } from "./lib/grove-id.mjs";
const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const UA = "PwndaWallet-fetch-swap-runtime";
const LOG = "[swap-runtime]";

// ─────────────────────────────────────────────────────────────────────────────
// PINS
// ─────────────────────────────────────────────────────────────────────────────

// Upstream source pins. These MUST match upstream/README.md's pin table — that
// file is the human-readable copy of the same contract.
const PIN_BASICSWAP_TAG = "v0.18.6";
const PIN_BASICSWAP_COMMIT = "ea39faddbcaffd51a34d6bbd72fb9607654227f5";
const PIN_COINCURVE_TAG = "basicswap_v0.4";
const PIN_COINCURVE_COMMIT = "ff375ce4ac551afc99f359da784ffceeda03203f";

// ── TARGET PLATFORM ─────────────────────────────────────────────────────────
// `--platform=win-x64` (default, unchanged) or `--platform=linux-x64`.
//
// Only SEVEN artifacts actually vary: CPython, three of the seven PyPI wheels,
// and the three coin cores. The other four wheels are `py3-none-any` and the
// basicswap wheel is `py3-none-any` too, so they are shared verbatim.
const PLATFORM = (() => {
  const a = process.argv.find((x) => x.startsWith("--platform="));
  const v = a ? a.slice("--platform=".length) : "win-x64";
  if (v !== "win-x64" && v !== "linux-x64") {
    console.error(`[swap-runtime] unknown --platform=${v} (want win-x64 | linux-x64)`);
    process.exit(2);
  }
  return v;
})();
const IS_WIN = PLATFORM === "win-x64";

// CPython. pyproject.toml requires >=3.11; 3.12 is what the cp312 wheels below
// are built for.
//
// MICRO VERSION DIVERGES BY PLATFORM, deliberately, and the old comment here
// overstated why it could not:
//
//   "the cp312 wheels below are ABI-matched to it. Moving CPython means
//    re-resolving every cp312 wheel."
//
// That is not right, and the evidence is in the filenames it describes.
// `MarkupSafe-3.0.2-cp312-cp312-win_amd64.whl` carries `cp312` — the MINOR
// version. A wheel tag has no micro field at all, so it CANNOT be matched to
// 3.12.10 rather than 3.12.14; `abi3` wheels are broader still. What the micro
// version does pin is the STDLIB shipped alongside, which is a behaviour
// contract, not an ABI one.
//
// The divergence is forced rather than chosen: python.org publishes an
// **embeddable** build for Windows only — there is no Linux equivalent, only
// source tarballs — so Linux uses python-build-standalone, which keeps a
// limited window of micro versions reachable and no longer publishes 3.12.10.
const PIN_CPYTHON = IS_WIN ? "3.12.10" : "3.12.14";
const PBS_RELEASE = "20260825"; // python-build-standalone release tag
const CPYTHON = IS_WIN
  ? {
      name: "cpython-embeddable",
      file: `python-${PIN_CPYTHON}-embed-amd64.zip`,
      urls: [`https://www.python.org/ftp/python/${PIN_CPYTHON}/python-${PIN_CPYTHON}-embed-amd64.zip`],
      // Re-downloaded from python.org 2026-08-18 and hashed; matches the copy the
      // hand-built runtime came from (.swap-sidecar-work/dl/).
      sha256: "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
      bytes: 11133606,
    }
  : {
      // python-build-standalone: relocatable CPython, the de-facto portable
      // build for Linux. `install_only` is the right variant — a normal prefix
      // tree with no build artifacts. NOT an "embeddable" build: there is no
      // `python312._pth` on Linux, so the assembly step differs (see `assembly`).
      name: "cpython-standalone",
      file: `cpython-${PIN_CPYTHON}+${PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
      urls: [
        `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/` +
          `cpython-${PIN_CPYTHON}%2B${PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
      ],
      // Downloaded and hashed 2026-08-26 by scripts/resolve-linux-runtime-pins.mjs.
      // python-build-standalone publishes no .sha256 sidecar for this asset, so
      // this is OUR hash of THEIR bytes — weaker provenance than the monero pin
      // below, and stated as such rather than assumed equivalent.
      sha256: "cbdd2f0cf02f941bc5c81e546f377275e322733abffe805ac29d2b7e8a58f7e3",
      bytes: 109290197,
    };

// Wheels fetched from PyPI. Every sha256 here also appears as a --hash= pin in
// upstream/basicswap/requirements.txt, so these are upstream's pins, not ours.
// URLs are the immutable files.pythonhosted content-addressed paths.
const PYPI_WHEELS = [
  {
    name: "jinja2",
    version: "3.1.6",
    file: "jinja2-3.1.6-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/62/a1/3d680cbfd5f4b8f15abc1d571870c5fc3e594bb582bc3b64ea099db13e56/jinja2-3.1.6-py3-none-any.whl",
    sha256: "85ece4451f492d0c13c5dd7c13a64681a86afae63a5f347908daf103ce6d2f67",
    bytes: 134899,
  },
  {
    name: "MarkupSafe",
    version: "3.0.2",
    ...(IS_WIN
      ? {
          file: "MarkupSafe-3.0.2-cp312-cp312-win_amd64.whl",
          url: "https://files.pythonhosted.org/packages/c1/80/a61f99dc3a936413c3ee4e1eecac96c0da5ed07ad56fd975f1a9da5bc630/MarkupSafe-3.0.2-cp312-cp312-win_amd64.whl",
          sha256: "8e06879fc22a25ca47312fbe7c8264eb0b662f6db27cb2d3bbbc74b1df4b9b87",
          bytes: 15601,
        }
      : {
          file: "MarkupSafe-3.0.2-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
          url: "https://files.pythonhosted.org/packages/f3/f0/89e7aadfb3749d0f52234a0c8c7867877876e0a20b60e2188e9850794c17/MarkupSafe-3.0.2-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
          sha256: "e17c96c14e19278594aa4841ec148115f9c7615a47382ecb6b82bd8fea3ab0c8",
          bytes: 23118,
        }),
  },
  {
    name: "pycryptodome",
    version: "3.23.0",
    ...(IS_WIN
      ? {
          file: "pycryptodome-3.23.0-cp37-abi3-win_amd64.whl",
          url: "https://files.pythonhosted.org/packages/54/2f/e97a1b8294db0daaa87012c24a7bb714147c7ade7656973fd6c736b484ff/pycryptodome-3.23.0-cp37-abi3-win_amd64.whl",
          sha256: "c75b52aacc6c0c260f204cbdd834f76edc9fb0d8e0da9fbf8352ef58202564e2",
          bytes: 1799636,
        }
      : {
          file: "pycryptodome-3.23.0-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
          url: "https://files.pythonhosted.org/packages/5f/e9/a09476d436d0ff1402ac3867d933c61805ec2326c6ea557aeeac3825604e/pycryptodome-3.23.0-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
          sha256: "c8987bd3307a39bc03df5c8e0e3d8be0c4c3518b7f044b0f4c15d1aa78f52575",
          bytes: 2268954,
        }),
    importName: "Crypto",
  },
  {
    name: "PySocks",
    version: "1.7.1",
    file: "PySocks-1.7.1-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/8d/59/b4572118e098ac8e46e399a1dd0f2d85403ce8bbaad9ec79373ed6badaf9/PySocks-1.7.1-py3-none-any.whl",
    sha256: "2725bd0a9925919b9b51739eea5f9e2bae91e83288108a9ad338b2e3a4435ee5",
    bytes: 16725,
    importName: "socks",
  },
  {
    name: "python-gnupg",
    version: "0.5.6",
    file: "python_gnupg-0.5.6-py2.py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/d2/ab/0ea9de971caf3cd2e268d2b05dfe9883b21cfe686a59249bd2dccb4bae33/python_gnupg-0.5.6-py2.py3-none-any.whl",
    sha256: "b5050a55663d8ab9fcc8d97556d229af337a87a3ebebd7054cbd8b7e2043394a",
    bytes: 22082,
    importName: "gnupg",
  },
  {
    name: "pyzmq",
    version: "27.2.0",
    ...(IS_WIN
      ? {
          file: "pyzmq-27.2.0-cp312-abi3-win_amd64.whl",
          url: "https://files.pythonhosted.org/packages/02/8b/b83f7780dad22e0878e4c7bd9158ebd24ed12bc3d5e3a471cd0576f77ded/pyzmq-27.2.0-cp312-abi3-win_amd64.whl",
          sha256: "2c218c6ab8bc447ba62054b581fd30209689d199c6ecb253f79615ca74a38e12",
          bytes: 628633,
        }
      : {
          file: "pyzmq-27.2.0-cp312-abi3-manylinux_2_26_x86_64.manylinux_2_28_x86_64.whl",
          url: "https://files.pythonhosted.org/packages/62/2c/d5828306f795e8d34676d266823b74e2101e0ad3760d12083de3e02abbb2/pyzmq-27.2.0-cp312-abi3-manylinux_2_26_x86_64.manylinux_2_28_x86_64.whl",
          sha256: "dea74fd65f1fc5f7fe167916a473ebe6ed6174e5e5d9de11ea6583661be6cf43",
          bytes: 872258,
        }),
    importName: "zmq",
  },
  {
    name: "websocket-client",
    version: "1.9.0",
    file: "websocket_client-1.9.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/34/db/b10e48aa8fff7407e67470363eac595018441cf32d5e1001567a7aeba5d2/websocket_client-1.9.0-py3-none-any.whl",
    sha256: "af248a825037ef591efbf6ed20cc5faa03d3b47b9e5a2230a529eeee1c1fc3ef",
    bytes: 82616,
    importName: "websocket",
  },
];

// Source archive that the coincurve fork wheel is built FROM. Pinning it is what
// makes the wheel build reproducible-from-inputs even though the wheel itself is
// not bit-reproducible. This sha256 is upstream's own requirements.txt pin.
const COINCURVE_SRC = {
  name: "coincurve-fork-source",
  file: "coincurve-basicswap_v0.4.zip",
  urls: [`https://github.com/basicswap/coincurve/archive/refs/tags/${PIN_COINCURVE_TAG}.zip`],
  sha256: "5a96faeeaf202c69ec8c1807086d5139541048dddf8b7f19a144ea9100a2f0be",
  bytes: 155031,
};

// Wheels BUILT LOCALLY. Not fetchable; picked up from --wheelhouse and verified
// against a pinned artifact hash.
//
// NOT_REPRODUCIBLE: neither build is bit-for-bit stable. Measured for coincurve
// on 2026-08-15 — two builds of the same source produced
//   838034d2e96f64c1fa400e343c4823f225921305443097dcc0dacdc38e196cf7 (1409212 B)
//   df1177be9978939a739a24b6ae59de98aad6ee553bdd35ee1017a545676cea9a (1409213 B)
// (different length, so not just a timestamp field). The basicswap_v0.4 rebuild
// on 2026-08-26 minted a third artifact, 6aa95a14... (1433711 B), and the fork
// itself moved 21.0.3 -> 21.0.4 -- version alone still cannot tell the fork from
// upstream coincurve, so the six-symbol gate was re-run and passed before this
// pin was written. A REBUILD WILL NOT MATCH THE
// PIN BELOW and that is not by itself a supply-chain event. What is pinned is the
// ARTIFACT this project actually ships. If you rebuild, you are minting a new
// artifact: re-run the fork-symbol gate (pwnda-engine-handoff/tools/
// verify-coincurve.py — the six swap symbols are the ONLY thing that distinguishes
// the fork from upstream coincurve; name and version are identical), then update
// this pin in the same commit that ships the new wheel.
const WIN_ASSEMBLY_STEPS = [
  "Unzip python/<cpython zip> to <runtime>.",
  "Edit <runtime>/python312._pth: entries python312.zip, '.', 'Lib\\\\site-packages'; leave '#import site' COMMENTED OUT.",
  "With an EXTERNAL python: python -m pip install --no-index --find-links <out>/wheels --target <runtime>/Lib/site-packages basicswap coincurve jinja2 markupsafe pycryptodome pysocks python-gnupg pyzmq websocket-client",
  "Apply upstream/patches/*.patch to <runtime>/Lib/site-packages/basicswap (or build the wheel from a pre-patched tree).",
  "Delete <runtime>/Lib/site-packages/pip*, <runtime>/Scripts, and every __pycache__.",
  "Invoke only as: <runtime>\\\\python.exe -s -E -m <module>",
];

const LOCAL_WHEELS = [
  {
    name: "coincurve",
    version: "21.0.4",
    fork: true,
    buildFrom: `upstream/coincurve @ ${PIN_COINCURVE_TAG} (${PIN_COINCURVE_COMMIT})`,
    // The fork publishes NO releases and no wheels for ANY platform, so this is
    // built from the source zip on every target. That is why it is pinned by
    // ARTIFACT hash and not by build inputs (see NOT_REPRODUCIBLE).
    ...(IS_WIN
      ? {
          file: "coincurve-21.0.4-cp312-cp312-win_amd64.whl",
          sha256: "6aa95a14f4b8c62513331e45484584b8cc5c2e0edf049d3940eb6eb5ab179871",
          bytes: 1433711,
          buildBackend: "scikit-build-core + MSVC 14.44.35207",
          buildNote:
            "Do NOT set COINCURVE_IGNORE_SYSTEM_LIB=OFF. CMake reports a system libsecp256k1 " +
            "with a blank version on a box that has none; only the default " +
            "PROJECT_IGNORE_SYSTEM_LIB=ON keeps the vendored basicswap secp256k1 in play.",
        }
      : {
          // BUILT 2026-08-26 in quay.io/pypa/manylinux_2_28_x86_64 by
          // scripts/swap/build-coincurve-linux.sh. Source hash checked against
          // upstream's own requirements.txt pin before compiling; the six
          // adaptor/DLEAG symbols verified against the COMPILED library
          // afterwards (verify-coincurve.py), not against package metadata,
          // which cannot tell the fork from upstream.
          //
          // THE FILENAME IS auditwheel's, NOT OURS, and the earlier PREDICTION
          // here was wrong: we guessed a single `manylinux_2_28_x86_64` tag and
          // auditwheel emitted three. Its analysis found the wheel references
          // only GLIBC_2.2.5/2.3/2.14, so the real floor is **2.17** and it
          // tagged the broader set. Recorded because it inverts an assumption:
          // coincurve is NOT what sets this runtime's glibc floor -- pyzmq's
          // manylinux_2_28 wheel is. Re-resolving pyzmq could lower the floor
          // for the whole image.
          file: "coincurve-21.0.4-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl",
          sha256: "d48f50aa0e42df82be719ed677687283114d477874fffb1319479eb8d221138e",
          bytes: 1466969,
          buildBackend: "scikit-build-core + gcc (no MSVC dependency on Linux)",
          buildNote:
            "The same COINCURVE_IGNORE_SYSTEM_LIB caution applies, and is MORE likely to bite " +
            "on Linux: a distro libsecp256k1-dev is common, so CMake finding a system copy is " +
            "the normal case rather than the pathological one. Build in a container with a " +
            "pinned glibc so the manylinux tag is a decision instead of an accident.",
        }),
    reproducible: false,
  },
  {
    name: "basicswap",
    version: "0.18.6",
    file: "basicswap-0.18.6-py3-none-any.whl",
    // Rebuilt 2026-09-08 from upstream/basicswap @ v0.18.6 with the buildCmd
    // below; hash computed from the produced file, not taken from pip's log.
    // `reproducible: false` (below) is why this is "what we built and
    // verified" rather than a value anyone else can rederive byte-for-byte.
    sha256: "206971cfb959bfe8523ae4dbae00e555fc33cb5c63d01cd02e2d4fbc2280428e",
    bytes: 5215510,
    buildFrom: `upstream/basicswap @ ${PIN_BASICSWAP_TAG} (${PIN_BASICSWAP_COMMIT})`,
    buildBackend: "hatchling",
    buildCmd: "python -m pip wheel . --no-deps -w <wheelhouse>",
    buildNote:
      "The basicswap wheel declares dependencies = [] (pyproject.toml, '# See " +
      "requirements.txt'), so pip will NOT pull the rest in transitively. Every " +
      "distribution must be named explicitly at install time or the runtime " +
      "ImportErrors after a successful-looking install.",
    reproducible: false,
  },
];

// Coin daemons. Version defaults are read straight out of the pinned engine
// (basicswap/interface/<coin>/core.py); URL shapes are that same code's
// getReleaseUrl()/downloadCore(). Each sha256 was cross-checked against the
// upstream SIGNED build-assert manifest shipped alongside the release:
//   particl  -> particl-win-27.2.4.0-build-tecnovert.assert       (guix, signer tecnovert)
//   litecoin -> litecoin-win-0.21.5.6-build-davidburkett38.assert (gitian, signer davidburkett38)
//   monero   -> monero-0.18.5.1-hashes.txt @ XMR_SITE_COMMIT 76f3846d (signer binaryfate)
// We do not re-verify those signatures at fetch time (that is the U-2 gpg problem
// this script exists to route around); the pins below ARE the check.
const COIN_CORES = [
  {
    coin: "particl",
    version: "27.2.4.0",
    ...(IS_WIN
      ? {
          file: "particl-27.2.4.0-win64.zip",
          urls: [
            "https://github.com/tecnovert/particl-core/releases/download/v27.2.4.0/particl-27.2.4.0-win64.zip",
          ],
          sha256: "a036876b012c2f5ee6c56208a4bfc59282ee427b62a30c0b1234704277a74727",
          bytes: 61808008,
          binaries: ["particld.exe", "particl-cli.exe", "particl-tx.exe", "particl-wallet.exe"],
          assertFile: "particl-win-27.2.4.0-build-tecnovert.assert",
        }
      : {
          file: "particl-27.2.4.0-x86_64-linux-gnu.tar.gz",
          urls: [
            "https://github.com/tecnovert/particl-core/releases/download/v27.2.4.0/particl-27.2.4.0-x86_64-linux-gnu.tar.gz",
          ],
          sha256: "f7f038e870130a7e0bf72d786c376c537045d644fcaa3f5912ea7e61c2498d21",
          bytes: 64853298,
          binaries: ["particld", "particl-cli", "particl-tx", "particl-wallet"],
          assertFile: "particl-linux-27.2.4.0-build-tecnovert.assert",
        }),
    // Archive member prefix -> basename. particl/litecoin use <name>-<ver>/bin/
    // on BOTH platforms — verified 2026-08-26 by listing the real tarballs, not
    // assumed from the zip layout.
    memberPrefix: "particl-27.2.4.0/bin/",
    signer: "tecnovert",
  },
  {
    coin: "litecoin",
    version: "0.21.5.6",
    file: IS_WIN
      ? "litecoin-0.21.5.6-win64.zip"
      : "litecoin-0.21.5.6-x86_64-linux-gnu.tar.gz",
    // ORDER MATTERS AND IS NOT UPSTREAM'S. Upstream (interface/ltc/core.py
    // getReleaseUrl) lists the GitHub release first and download.litecoin.org as
    // fallback. Verified 2026-08-18: the GitHub URL returns HTTP 404 for this
    // version — there is no v0.21.5.6 release asset there — so upstream reaches
    // this coin only via its fallback. We put the working host first and keep
    // GitHub as the fallback, so a fetch here costs one request, not two.
    urls: IS_WIN
      ? [
          "https://download.litecoin.org/litecoin-0.21.5.6/win/litecoin-0.21.5.6-win64.zip",
          "https://github.com/litecoin-project/litecoin/releases/download/v0.21.5.6/litecoin-0.21.5.6-win64.zip",
        ]
      : [
          // Same host-ordering rationale as the Windows pair above. Both mirrors
          // verified reachable for the Linux asset 2026-08-26 (unlike the Windows
          // GitHub URL, which 404s), so here the order is preference, not repair.
          "https://download.litecoin.org/litecoin-0.21.5.6/linux/litecoin-0.21.5.6-x86_64-linux-gnu.tar.gz",
          "https://github.com/litecoin-project/litecoin/releases/download/v0.21.5.6/litecoin-0.21.5.6-x86_64-linux-gnu.tar.gz",
        ],
    ...(IS_WIN
      ? {
          sha256: "6e93dfac5ac7339af8b75132a6a89b666ec2e196562c1fade6aba8ed3420a94e",
          bytes: 34138150,
          binaries: ["litecoind.exe", "litecoin-cli.exe", "litecoin-tx.exe", "litecoin-wallet.exe"],
          assertFile: "litecoin-win-0.21.5.6-build-davidburkett38.assert",
        }
      : {
          sha256: "3c0a217651a431ef446641669a0b74ce7dbcd9b9ed1a118fc830b8f6779ee83f",
          bytes: 36854271,
          binaries: ["litecoind", "litecoin-cli", "litecoin-tx", "litecoin-wallet"],
          assertFile: "litecoin-linux-0.21.5.6-build-davidburkett38.assert",
        }),
    memberPrefix: "litecoin-0.21.5.6/bin/",
    signer: "davidburkett38",
  },
  {
    coin: "monero",
    version: "0.18.5.1",
    // Monero's local filename and its remote filename differ; prepare stores it
    // as monero-<ver>-<arch>.<ext> while the CDN serves monero-<os>-x64-v<ver>.<ext>.
    ...(IS_WIN
      ? {
          file: "monero-0.18.5.1-win64.zip",
          urls: ["https://downloads.getmonero.org/cli/monero-win-x64-v0.18.5.1.zip"],
          sha256: "cf2ae8273977697d9ef2031c7337b781e6e5936578f602444b2990a173a2437d",
          bytes: 89069867,
          // Monero's archive is flat under one directory — no bin/ subdir.
          memberPrefix: "monero-x86_64-w64-mingw32-v0.18.5.1/",
          binaries: ["monerod.exe", "monero-wallet-rpc.exe"],
        }
      : {
          // NOTE the extension: Linux is .tar.bz2, not .zip. Anything that
          // branches on archive type by file suffix must handle bz2 — the
          // Windows path never had to.
          file: "monero-0.18.5.1-linux64.tar.bz2",
          urls: ["https://downloads.getmonero.org/cli/monero-linux-x64-v0.18.5.1.tar.bz2"],
          // Hash CROSS-CHECKED against getmonero.org/downloads/hashes.txt on
          // 2026-08-26, not merely computed from our own download: a hash we
          // take of bytes we fetched proves the download was self-consistent,
          // not that it is the publisher's artifact. This is the only pin in
          // the Linux table with publisher-side confirmation.
          sha256: "22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958",
          bytes: 84575716,
          // Verified by listing the real tarball, not inferred from the Windows
          // prefix.
          memberPrefix: "monero-x86_64-linux-gnu-v0.18.5.1/",
          binaries: ["monerod", "monero-wallet-rpc"],
        }),
    signer: "binaryfate",
    assertFile: "monero-0.18.5.1-hashes.txt",
  },
  {
    // Zephyr (ZEPH) — Grove follower coin, added for the Grove expansion
    // (unit A2, master plan § 3 Phase A). Same shape as monero above: a
    // DAEMON + WALLET-RPC pair the engine will manage via
    // `--nocores --bindir` once Phase B (B-Z2) wires the prepare registry —
    // this entry is the pin only, not the wiring.
    //
    // Unlike particl/litecoin/monero, Zephyr publishes NO signature of any
    // kind to cross-check against: all 69 assets across all 15 releases
    // (v0.1.0 -> v2.3.0) were checked and none carry a sha/sum/hash/sig/.asc/
    // gpg/pgp file, the release body has no inline hash, and no sigs repo
    // exists in the ZephyrProtocol org (REU26
    // ResearchWiki/synthesis/zeph-basicswap-pr-paths.md, re-verified
    // 2026-07-01). So `signer`/`assertFile` below are null — there is
    // nothing to name — and this pin is OUR sha256 of THEIR bytes, exactly
    // like the python-build-standalone pin above, not a cross-check against
    // a publisher-side hash.
    //
    // This is the SAME zip src-tauri/src/zph_rpc.rs already pins
    // (ZPH_ZIP_URL / ZPH_ZIP_FILENAME / ZPH_ZIP_SHA256) for the
    // wallet-rpc-only host-wallet download path — same URL, same filename,
    // same sha256, verified identical on purpose so the daemon+wallet-rpc
    // pair here and that standalone sidecar never drift onto two different
    // hashes of the same upstream release.
    coin: "zephyr",
    version: "2.3.0",
    ...(IS_WIN
      ? {
          file: "zephyr-cli-windows-v2.3.0.zip",
          urls: [
            "https://github.com/ZephyrProtocol/zephyr/releases/download/v2.3.0/zephyr-cli-windows-v2.3.0.zip",
          ],
          // Cross-checked 2026-09-02 against the GitHub Releases API's own
          // per-asset `digest` field (an independent channel from our
          // download) AND against zph_rpc.rs's existing production pin
          // (dated 2026-04-23 in that file's own log.md entry) — both agree.
          // NOT independently re-hashed from a fresh local download in THIS
          // session: Windows Defender real-time protection quarantined the
          // archive on write before `Get-FileHash`/`sha256sum` could run
          // (a Monero-lineage wallet-rpc false positive — the same class
          // zph_rpc.rs already documents for the extracted .exe, firing one
          // step earlier here on the .zip itself). Reproduced twice; see
          // log.md 2026-09-02. The byte SIZE below did land locally before
          // quarantine and matches the API's reported size exactly.
          sha256: "1139bde911980ff6f93e8540bf1b9d0b67370f33daf15f6b78d47360947d6726",
          bytes: 43663937,
          // Inferred from the linux archive's real layout (same release,
          // same packaging convention across platforms) — NOT independently
          // listed for win (Defender quarantine, see above). findFile()
          // below searches by basename regardless, so this is documentation
          // only, not load-bearing.
          memberPrefix: "zephyr-cli-windows-v2.3.0/",
          binaries: ["zephyrd.exe", "zephyr-wallet-rpc.exe"],
        }
      : {
          file: "zephyr-cli-linux-v2.3.0.zip",
          urls: [
            "https://github.com/ZephyrProtocol/zephyr/releases/download/v2.3.0/zephyr-cli-linux-v2.3.0.zip",
          ],
          // Independently re-hashed from a FRESH local download 2026-09-02
          // (`sha256sum zephyr-cli-linux-v2.3.0.zip`) — matches both the
          // GitHub API digest and zph_rpc.rs's existing pin exactly. Also
          // resolvable via scripts/resolve-linux-runtime-pins.mjs (entry
          // added there in the same commit as this one).
          sha256: "d60a94d187e288de0ea76d26ecba26c850cdec0500bba84699c7abe85d1a6f91",
          bytes: 29919501,
          // Independently verified: `unzip -l` on the fresh local download
          // lists this exact prefix, 2026-09-02.
          memberPrefix: "zephyr-cli-linux-v2.3.0/",
          binaries: ["zephyrd", "zephyr-wallet-rpc"],
        }),
    signer: null,
    assertFile: null,
  },
];

// Bitcoin core is deliberately NOT in the table. It is not fetched yet, and a
// pin nobody has verified is worse than an absent one — add it here with a
// cross-checked sha256 when BTC joins the supported pairs.
//
// Bitcoin IS ALREADY SEEDED on this machine, however: .swap-sidecar-work/bin/
// bitcoin/ carries bitcoind.exe + bitcoin-cli.exe + a real
// bitcoin-win-29.4-build-hebasto.assert(.sig) pair (hebasto is Bitcoin Core's
// guix signer) — found while verifying this unit's own additions, 2026-09-02.
// That means it was fetched and GPG-verified by SOME process, but neither
// this script's COIN_CORES nor scripts/swap/Get-SwapCoinBinaries.ps1's
// CATALOG has an entry for it — its provenance is not reproducible from
// anything committed in this repo. Flagged as a finding, not fixed here:
// bitcoin is out of scope for unit A2 (Grove expansion master plan § 3 Phase
// A row A2 owns zephyr/fulcrum/zano only), and the existing 7 coin
// directories under .swap-sidecar-work/bin (bitcoin, bitcoincash, dash,
// dogecoin, litecoin, monero, particl) are almost certainly where an earlier
// description of "seven existing GPG-verified coins" came from — but only 3
// of those 7 (dogecoin, dash, bitcoincash) actually go through
// Get-SwapCoinBinaries.ps1's live GPG path; particl/litecoin/monero are
// fetched here in fetch-swap-runtime.mjs via the sha256-pin bypass this
// file's own header documents (GPG never runs for them at fetch time,
// despite the cross-checked signer/assertFile fields above being present for
// documentation); and bitcoin has no pin anywhere in either owned script.

// Placeholder for the ZANO core (Grove expansion unit A5). Deliberately NOT
// included in COIN_CORES — a null `sha256`/`urls: []` entry would make
// `headCheck()` in --check and `fetchVerified()` in a full run fail on a URL
// that does not exist yet, breaking THIS unit's gate for a coin that is not
// this unit's job to pin. Kept here, inert, so:
//   (a) grep/read finds it next to its sibling cores instead of nowhere,
//   (b) unit A5 has one obvious slot shaped exactly like a real COIN_CORES
//       entry to fill in and `.push()` onto COIN_CORES once real, and
//   (c) this is the SECOND of the two exact placeholder locations named in
//       unit A2's report (the first is scripts/swap/Get-SwapCoinBinaries.ps1
//       $CATALOG.zano) — A5 depends on both.
// TODO(A5): fill file/urls/sha256/bytes/binaries/memberPrefix for win-x64 and
// linux-x64 once scripts/swap/zano-build/ produces the patched
// zanod+simplewallet build, then splice this into COIN_CORES (and delete
// this constant) in the SAME commit.
const ZANO_CORE_PLACEHOLDER = {
  coin: "zano",
  version: null, // TODO(A5)
  // Per PwndaWalletVault/wiki/synthesis/grove-zeph-zano-integration-plan.md
  // § 2.4/9.2: this is a pwnda-BUILT patched simplewallet (+ optionally
  // zanod), not a downloaded stock release, so `urls` will never be
  // fetchable the way COIN_CORES's other entries are — A5's build script
  // (scripts/swap/zano-build/) produces the artifact locally, this pin
  // verifies it, same shape as LOCAL_WHEELS above (localVerified, not
  // fetchVerified) once wired in for real.
  buildFrom: "hyle-team/zano @ ee3de1e5a077b60106ba88301e236474680b1028 + zano-0001-wallet-rpc-generate-from-keys.patch",
  // BUILT 2026-09-04 (win-x64). Unit A5 completed for Windows: Build-ZanoWallet.ps1
  // ran to completion for the first time on this machine after two PowerShell 5.1
  // defects in it were fixed (empty $PSScriptRoot in param() defaults; a native
  // command's stderr terminating the run under ErrorActionPreference=Stop).
  //
  // These sha256s are of OUR build, recorded the way LOCAL_WHEELS records a
  // locally-produced artifact -- `urls` stays empty and this entry is still NOT
  // spliced into COIN_CORES, because COIN_CORES entries are FETCHED
  // (`fetchVerified`) and there is nothing to fetch. Wiring it as a fetchable
  // core would make --check try to HEAD a URL that will never exist.
  //
  // Patch presence verified against the binary, not assumed: `generate_from_keys`
  // is present in this build and ABSENT from the stock v2.2.1.506 simplewallet
  // this repo already ships, with `getbalance` present in both as the control
  // proving the probe discriminates.
  win: {
    file: "simplewallet.exe + zanod.exe (local build, scripts/swap/zano-build/out/)",
    urls: [],
    sha256: {
      "zanod.exe": "8b5d8ca031aa5a0ba40320d0cf5a9c066e727db971db497b7883448b0b03eef0",
      "simplewallet.exe": "4830cae213799aa3861c0c35b3406ac82e678e2068b5840b04cea68feff9a22f",
    },
    bytes: { "zanod.exe": 19246080, "simplewallet.exe": 17922048 },
    binaries: ["zanod.exe", "simplewallet.exe"],
  },
  // TODO(A5-linux): the Linux arm is still unbuilt -- build-zano-linux.sh needs
  // Docker, whose engine does not start on this machine (backend crash on its
  // own ingest socket, see zano-build/README.md "Gate status"). Windows
  // installers ship zano as of today; Linux ones do not.
  linux: { file: null, urls: [], sha256: null, bytes: null, binaries: ["zanod", "simplewallet"] },
  signer: null,
  assertFile: null,
  placeholder: false, // win-x64 real; linux still pending
};

// ─────────────────────────────────────────────────────────────────────────────
// args
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const FORCE = args.includes("--force");

function argValue(flag, fallback) {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? path.resolve(hit.slice(flag.length + 1)) : fallback;
}

const OUT_DIR = argValue("--out", path.join(REPO_ROOT, ".swap-sidecar-work", "swap-runtime-stage"));
const CACHE_DIR = argValue("--cache", path.join(REPO_ROOT, ".cache", "swap-runtime-fetch"));
const WHEELHOUSE = argValue("--wheelhouse", path.join(REPO_ROOT, ".swap-sidecar-work", "wheelhouse"));

const unknown = args.filter(
  (a) => a !== "--check" && a !== "--force" && !/^--(out|cache|wheelhouse|platform)=/.test(a)
);
if (unknown.length) {
  console.error(`${LOG} unknown argument(s): ${unknown.join(", ")}`);
  console.error(`${LOG} usage: node scripts/fetch-swap-runtime.mjs [--check] [--force] [--platform=win-x64|linux-x64] [--out=DIR] [--cache=DIR] [--wheelhouse=DIR]`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

let WARNINGS = 0;
function warn(msg) {
  WARNINGS += 1;
  console.warn(`${LOG}   ! ${msg}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(p) {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

function mb(n) {
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** HEAD every candidate URL; resolve as soon as one answers 2xx. */
async function headCheck(urls) {
  const tried = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA } });
      const len = res.headers.get("content-length");
      tried.push({ url, status: res.status, contentLength: len ? Number(len) : null });
      if (res.ok) return { ok: true, tried };
    } catch (e) {
      tried.push({ url, status: null, error: e.message });
    }
  }
  return { ok: false, tried };
}

async function download(urls, dest) {
  let lastErr = null;
  for (const url of urls) {
    try {
      console.log(`${LOG}   GET ${url}`);
      const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return url;
    } catch (e) {
      lastErr = e;
      warn(`${url} -> ${e.message}${urls.length > 1 ? " (trying fallback)" : ""}`);
      await rm(dest, { force: true });
    }
  }
  throw new Error(`all URLs failed for ${path.basename(dest)}: ${lastErr?.message}`);
}

/**
 * Fetch (or reuse from cache) and verify one pinned artifact.
 * A hash mismatch DELETES the file and throws — never keep an unverified byte.
 */
async function fetchVerified({ label, urls, file, sha256, bytes }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, file);

  if (FORCE) await rm(cached, { force: true });
  let sourceUrl = null;
  if (await exists(cached)) {
    console.log(`${LOG}   (cached) ${file}`);
  } else {
    sourceUrl = await download(urls, cached);
  }

  const actual = await sha256File(cached);
  if (actual !== sha256) {
    await rm(cached, { force: true });
    throw new Error(
      `${label}: SHA256 MISMATCH for ${file}\n  expected ${sha256}\n  actual   ${actual}\n` +
        `Cached file deleted. This is a supply-chain event OR a moved pin — do not "just re-run".`
    );
  }
  const size = (await stat(cached)).size;
  if (typeof bytes === "number" && size !== bytes) {
    // Cannot actually happen once the sha matches; kept as a cheap tripwire in
    // case a pin is edited with a stale byte count.
    warn(`${file} size ${size} != pinned ${bytes} (sha256 matched — fix the pin's byte count)`);
  }
  console.log(`${LOG}   ok ${file}  ${mb(size)}  sha256 verified`);
  return { path: cached, bytes: size, sourceUrl };
}

/** Pick up a locally built artifact and verify it against its pinned hash. */
async function localVerified({ label, dir, file, sha256 }) {
  const src = path.join(dir, file);
  if (!(await exists(src))) {
    return { missing: true, path: src };
  }
  const actual = await sha256File(src);
  if (actual !== sha256) {
    throw new Error(
      `${label}: SHA256 MISMATCH for locally built ${file}\n  expected ${sha256}\n  actual   ${actual}\n` +
        `If you rebuilt this wheel, the mismatch is EXPECTED (the build is not bit-reproducible).\n` +
        `Re-run the fork-symbol gate, then update the pin in this script in the same commit.`
    );
  }
  const size = (await stat(src)).size;
  console.log(`${LOG}   ok ${file}  ${mb(size)}  sha256 verified (local build)`);
  return { path: src, bytes: size, missing: false };
}

/**
 * Extract an archive, dispatching on its TYPE rather than on the host OS.
 *
 * The Windows coin cores are `.zip`; the Linux ones are `.tar.gz` and -- monero
 * alone -- `.tar.bz2`. The original implementation branched only on
 * `process.platform` and always assumed a zip, so the first Linux fetch died on
 * particl with:
 *
 *   Expand-Archive ... NotSupportedArchiveFileExtension
 *
 * Host and archive type are independent axes: this repo's normal case is a
 * WINDOWS host fetching LINUX artifacts. `tar` handles both compressions and
 * ships with Git for Windows (GNU tar 1.35) as well as every Linux image, so it
 * is the portable half; `Expand-Archive`/`unzip` stay for the zip half.
 */
async function extractArchive(archivePath, outDir) {
  await mkdir(outDir, { recursive: true });
  const lower = archivePath.toLowerCase();

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar.bz2")) {
    // -x auto-detects the compression in GNU tar and bsdtar alike, so gz and
    // bz2 need no separate flag; naming them would just be a way to get one
    // wrong.
    const args = ["-xf", archivePath, "-C", outDir];
    // GNU tar reads a leading `G:` as a REMOTE host spec ("Cannot connect to G:
    // resolve failed") and does it for forward AND back slashes alike, so this
    // is not a path-separator problem and cannot be fixed by normalising them.
    // --force-local is GNU-only, so it is added only for a drive-letter path,
    // which is the only case that needs it.
    if (/^[A-Za-z]:/.test(archivePath)) args.unshift("--force-local");
    try {
      await execFileP("tar", args, { maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      // A Windows host cannot create the .so version symlinks a Linux tarball
      // carries, and tar exits non-zero for them. That is NOT fatal here: the
      // caller takes only the NAMED binaries out of the tree and throws by name
      // if one is missing, so the real gate is downstream and specific. Warn
      // loudly rather than either dying on an irrelevant symlink or swallowing
      // a genuine extraction failure in silence.
      const msg = String(e?.stderr || e?.message || e);
      const onlySymlinks =
        /Cannot create symlink/.test(msg) && !/Cannot open|Unexpected EOF|not recoverable/.test(msg);
      console.log(
        `${LOG}   ! tar exited non-zero for ${path.basename(archivePath)}` +
          `${onlySymlinks ? " (symlinks only — a Windows host cannot create them)" : ""}`
      );
      if (!onlySymlinks) {
        console.log(`${LOG}     ${msg.replace(/\s+/g, " ").slice(0, 240)}`);
      }
      console.log(`${LOG}     continuing: the per-binary check below is what decides.`);
    }
    return;
  }

  if (!lower.endsWith(".zip")) {
    throw new Error(
      `extractArchive: unrecognised archive type for ${path.basename(archivePath)} — ` +
        `refusing to guess. Add the type here rather than letting it fall through to a zip reader.`
    );
  }

  if (process.platform === "win32") {
    await execFileP(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`,
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    );
  } else {
    await execFileP("unzip", ["-oq", archivePath, "-d", outDir], { maxBuffer: 32 * 1024 * 1024 });
  }
}

/** Recursively find the first file whose basename matches `name`. */
async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

/**
 * ENGINE-TREE.json scheme `sha256-of-sorted-sha256-lines-v1`.
 *
 * Two footguns are baked into the spec and both are reproduced here on purpose:
 *   1. TWO SPACES between hash and name. sha256sum prints " *" in BINARY mode and
 *      Git Bash on Windows defaults to binary, so a naive shell pipeline yields a
 *      different hash for byte-identical files and reports false drift.
 *   2. BYTEWISE sort. `sort -k2` under a UTF-8 locale ignores punctuation and case
 *      on its first pass, which moves names like `__init__.py`, `MarkupSafe-*` and
 *      `PySocks-*`; LC_ALL=C is load-bearing even where a naive run happens to
 *      agree.
 * Node's Buffer.compare gives the bytewise order directly.
 */
function treeHash(entries) {
  const lines = entries
    .slice()
    .sort((a, b) => Buffer.from(a.file, "utf8").compare(Buffer.from(b.file, "utf8")))
    .map((e) => `${e.sha256}  ${e.file}\n`);
  return {
    treeHash: createHash("sha256").update(Buffer.from(lines.join(""), "utf8")).digest("hex"),
    lines,
  };
}

/** Copy into the stage dir and return a manifest row (path is POSIX-relative). */
async function stage(srcPath, relDest, extra = {}) {
  const dest = path.join(OUT_DIR, relDest);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(srcPath, dest);
  const sha256 = await sha256File(dest);
  const bytes = (await stat(dest)).size;
  return { file: relDest.split(path.sep).join("/"), bytes, sha256, ...extra };
}

// ─────────────────────────────────────────────────────────────────────────────
// --check
// ─────────────────────────────────────────────────────────────────────────────

async function runCheck() {
  console.log(`${LOG} --check: reachability + pins only. No archives are downloaded.`);
  console.log("");
  console.log(`${LOG} PINS`);
  console.log(`${LOG}   basicswap        ${PIN_BASICSWAP_TAG}  ${PIN_BASICSWAP_COMMIT}`);
  console.log(`${LOG}   coincurve (fork) ${PIN_COINCURVE_TAG}  ${PIN_COINCURVE_COMMIT}`);
  console.log(`${LOG}   CPython          ${PIN_CPYTHON}  (cp312 / win_amd64)`);
  for (const c of COIN_CORES) console.log(`${LOG}   core ${c.coin.padEnd(9)} ${c.version}`);
  console.log(
    `${LOG}   core ${ZANO_CORE_PLACEHOLDER.coin.padEnd(9)} PLACEHOLDER — TODO(A5), not in COIN_CORES, not checked below`
  );
  console.log("");

  let unreachable = 0;
  const remote = [
    { label: `cpython ${PIN_CPYTHON}`, urls: CPYTHON.urls, sha256: CPYTHON.sha256 },
    { label: "coincurve source zip", urls: COINCURVE_SRC.urls, sha256: COINCURVE_SRC.sha256 },
    ...PYPI_WHEELS.map((w) => ({ label: `wheel ${w.name} ${w.version}`, urls: [w.url], sha256: w.sha256 })),
    ...COIN_CORES.map((c) => ({ label: `core ${c.coin} ${c.version}`, urls: c.urls, sha256: c.sha256 })),
  ];

  console.log(`${LOG} REMOTE ARTIFACTS (HEAD)`);
  for (const r of remote) {
    const res = await headCheck(r.urls);
    if (res.ok) {
      const hit = res.tried[res.tried.length - 1];
      const skipped = res.tried.length - 1;
      console.log(
        `${LOG}   ok  ${r.label.padEnd(28)} HTTP ${hit.status}` +
          `${hit.contentLength ? `, ${mb(hit.contentLength)}` : ""}` +
          `${skipped ? ` (after ${skipped} dead URL${skipped > 1 ? "s" : ""})` : ""}`
      );
      for (const t of res.tried.slice(0, -1)) {
        warn(`dead: ${t.url} -> ${t.status ?? t.error}`);
      }
    } else {
      unreachable += 1;
      console.error(`${LOG}   FAIL ${r.label}`);
      for (const t of res.tried) console.error(`${LOG}        ${t.url} -> ${t.status ?? t.error}`);
    }
    // "pinned/declared", not a bare "sha256": --check is a HEAD probe and never
    // downloads, so it CANNOT have verified this. A bare `sha256 <hex>` beside
    // an `ok` reads as confirmation -- it fooled the author of the Linux port,
    // who corrupted a pin, watched --check still print ok and exit 0, and only
    // then read the fetch call. Enforcement happens on a REAL run
    // (SHA256 MISMATCH in fetchToCache) and in resolve-linux-runtime-pins.mjs.
    console.log(`${LOG}        pinned ${r.sha256} (declared, NOT verified by --check)`);
  }

  console.log("");
  console.log(`${LOG} LOCALLY BUILT ARTIFACTS (not fetchable; from ${WHEELHOUSE})`);
  for (const w of LOCAL_WHEELS) {
    const src = path.join(WHEELHOUSE, w.file);
    // A null pin means this artifact has NEVER been built on this platform, so
    // no hash of it exists to compare against. It is reported as its own state:
    // "absent and unpinned" is a different fact from "absent but pinned", and
    // printing `pinned sha256 null` blurred exactly that distinction.
    const unpinned = w.sha256 === null;
    if (!(await exists(src))) {
      if (unpinned) {
        warn(`ABSENT + UNPINNED ${w.file} — never built for this platform, so there is no pin yet`);
        console.log(`${LOG}        filename above is a PREDICTION; confirm it and record the hash once built`);
      } else {
        warn(`ABSENT ${w.file} — must be built before a full run can stage it`);
        console.log(`${LOG}        pinned sha256 ${w.sha256}`);
      }
      continue;
    }
    const actual = await sha256File(src);
    if (unpinned) {
      // Present but unpinned. NOT a pass: staging an artifact nobody has ever
      // hashed is the whole thing the pin exists to prevent.
      unreachable += 1;
      console.error(`${LOG}   FAIL ${w.file} is present but UNPINNED`);
      console.error(`${LOG}        built hash ${actual}`);
      console.error(`${LOG}        record it as this artifact's sha256, then re-run.`);
    } else if (actual === w.sha256) {
      console.log(`${LOG}   ok  ${w.file.padEnd(46)} sha256 matches pin`);
    } else {
      unreachable += 1;
      console.error(`${LOG}   FAIL ${w.file} sha256 ${actual} != pinned ${w.sha256}`);
      console.error(`${LOG}        (a REBUILD legitimately produces a different hash — see NOT_REPRODUCIBLE)`);
    }
  }

  console.log("");
  if (unreachable > 0) {
    console.error(`${LOG} check FAILED: ${unreachable} artifact(s) unreachable or mismatched.`);
    process.exit(1);
  }
  console.log(
    `${LOG} check complete — every pinned remote artifact is REACHABLE` +
      `${WARNINGS ? `, ${WARNINGS} warning(s) above` : ""}.`
  );
  console.log(
    `${LOG} NOT established here: that those bytes match their pins. --check is a HEAD probe.`
  );
  console.log(
    `${LOG} Hashes are enforced on a real (non-check) run; Linux pins were resolved by ` +
      `scripts/resolve-linux-runtime-pins.mjs.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// full run
// ─────────────────────────────────────────────────────────────────────────────

async function runFull() {
  console.log(`${LOG} staging into ${OUT_DIR}`);
  console.log(`${LOG} cache        ${CACHE_DIR}`);
  console.log(`${LOG} wheelhouse   ${WHEELHOUSE}`);
  await mkdir(OUT_DIR, { recursive: true });

  const artifacts = [];

  // 1. CPython embeddable ----------------------------------------------------
  console.log(`${LOG} CPython ${PIN_CPYTHON} (embeddable, amd64)`);
  {
    const got = await fetchVerified({ label: "cpython", ...CPYTHON });
    artifacts.push(
      await stage(got.path, path.join("python", CPYTHON.file), {
        kind: "cpython-embeddable",
        version: PIN_CPYTHON,
        url: CPYTHON.urls[0],
      })
    );
  }

  // 2. Wheels from PyPI ------------------------------------------------------
  console.log(`${LOG} wheels from PyPI (${PYPI_WHEELS.length})`);
  for (const w of PYPI_WHEELS) {
    const got = await fetchVerified({ label: `wheel ${w.name}`, urls: [w.url], file: w.file, sha256: w.sha256, bytes: w.bytes });
    artifacts.push(
      await stage(got.path, path.join("wheels", w.file), {
        kind: "wheel",
        origin: "pypi",
        distribution: w.name,
        version: w.version,
        importName: w.importName ?? null,
        url: w.url,
        sha256InRequirementsTxt: true,
      })
    );
  }

  // 3. coincurve fork SOURCE zip (build input for the local wheel) ------------
  console.log(`${LOG} coincurve fork source (${PIN_COINCURVE_TAG})`);
  {
    const got = await fetchVerified({ label: "coincurve source", ...COINCURVE_SRC });
    artifacts.push(
      await stage(got.path, path.join("sources", COINCURVE_SRC.file), {
        kind: "source-archive",
        distribution: "coincurve",
        tag: PIN_COINCURVE_TAG,
        commit: PIN_COINCURVE_COMMIT,
        url: COINCURVE_SRC.urls[0],
        sha256InRequirementsTxt: true,
      })
    );
  }

  // 4. Locally built wheels --------------------------------------------------
  console.log(`${LOG} locally built wheels (${LOCAL_WHEELS.length})`);
  for (const w of LOCAL_WHEELS) {
    const got = await localVerified({ label: `wheel ${w.name}`, dir: WHEELHOUSE, file: w.file, sha256: w.sha256 });
    if (got.missing) {
      throw new Error(
        `wheel ${w.name}: ${w.file} not found in ${WHEELHOUSE}\n` +
          `  It is BUILT, not fetched, from ${w.buildFrom}.\n` +
          `  Build it and re-run, or pass --wheelhouse=<dir containing it>.`
      );
    }
    artifacts.push(
      await stage(got.path, path.join("wheels", w.file), {
        kind: "wheel",
        origin: "built-locally",
        distribution: w.name,
        version: w.version,
        fork: w.fork ?? false,
        buildFrom: w.buildFrom,
        buildBackend: w.buildBackend,
        buildCmd: w.buildCmd ?? null,
        buildNote: w.buildNote,
        bitReproducible: false,
      })
    );
  }

  // 5. Coin daemons ----------------------------------------------------------
  console.log(`${LOG} coin cores (${COIN_CORES.length})`);
  for (const c of COIN_CORES) {
    const got = await fetchVerified({ label: `core ${c.coin}`, urls: c.urls, file: c.file, sha256: c.sha256, bytes: c.bytes });

    const workDir = path.join(CACHE_DIR, `${c.coin}-x`);
    await rm(workDir, { recursive: true, force: true });
    await extractArchive(got.path, workDir);

    for (const bin of c.binaries) {
      const found = await findFile(workDir, bin);
      if (!found) throw new Error(`core ${c.coin}: ${bin} not found inside ${c.file}`);
      artifacts.push(
        await stage(found, path.join("cores", c.coin, bin), {
          kind: "coin-daemon",
          coin: c.coin,
          version: c.version,
          fromArchive: c.file,
          archiveSha256: c.sha256,
          archiveMember: `${c.memberPrefix}${bin}`,
          upstreamSigner: c.signer,
          upstreamAssertFile: c.assertFile,
        })
      );
    }
    await rm(workDir, { recursive: true, force: true });
    console.log(`${LOG}   staged ${c.binaries.length} binaries -> cores/${c.coin}/`);
  }

  // 6. Manifest --------------------------------------------------------------
  const { treeHash: tree, lines } = treeHash(artifacts);
  // Enumerated from the directory, never hand-listed: the hand-kept copy of this
  // list sat at "2 patches" while the series grew to 12 (found 2026-08-26), so a
  // consumer reading `series` as the list would have shipped a runtime missing
  // every wallet-safety patch. The directory is the authority.
  const enginePatchSeries = (await readdir(path.join(REPO_ROOT, "upstream", "patches")))
    .filter((f) => /^\d{4}-.*\.patch$/.test(f))
    .sort();
  const manifest = {
    schema: "pwnda.swap-sidecar.runtime-inputs/1",
    // The distribution this runtime becomes once the series is applied. The
    // manifest describes STAGED INPUTS, so this is the INTENDED identity, not a
    // measurement -- the runtime's own `pwnda-grove.json`, written by
    // apply-engine-patches.mjs from markers actually present, is the measured
    // one. Naming both and keeping them distinct is deliberate: conflating
    // "what we meant to build" with "what is running" is the 2026-08-25
    // PATCH-9 fault.
    distribution: {
      name: DISTRO_NAME,
      intendedId: groveId("0.18.5", enginePatchSeries.length),
      upstream: "basicswap v0.18.5",
      _what:
        "Pwnda Grove is a DISTRIBUTION of BasicSwap: a pinned upstream tag plus " +
        "the tracked patch series in upstream/patches/. Not a fork -- the ENGINE " +
        "layer is never modified (see wiki: basicswap-engine-boundary-map). Not " +
        "to be confused with pwnda-desk's vendored ltc-xmr/ada-xmr engines, " +
        "which are separately BasicSwap-derived and are a different thing.",
    },
    _what:
      "Every pinned input the BasicSwap swap sidecar runtime is built from, fetched " +
      "and sha256-verified by scripts/fetch-swap-runtime.mjs. Staged, not assembled — " +
      "see `assembly` for the step this script deliberately does not perform.",
    _definition:
      "treeHash = sha256 over lines '<sha256 of file bytes><TWO SPACES><relative path>\\n', " +
      "sorted by path BYTEWISE, over every artifact listed in `artifacts` (this manifest " +
      "itself excluded). The two-space separator is part of the spec: the lines are the " +
      "input to the outer hash. So is the bytewise sort. Scheme copied from " +
      "pwnda-engine-handoff/ENGINE-TREE.json.",
    _recompute:
      "cd <out> && find . -type f ! -name swap-runtime.json -printf '%P\\n' | LC_ALL=C sort | " +
      "xargs sha256sum | sed 's/^\\([0-9a-f]\\{64\\}\\) \\*/\\1  /' | LC_ALL=C sort -k2 | sha256sum",
    _recompute_note:
      "The sed is NOT decoration: sha256sum prints two spaces in TEXT mode and ' *' in BINARY " +
      "mode, and Git Bash on Windows defaults to binary — the naive pipeline returns a different " +
      "hash for byte-identical files and reports false drift. LC_ALL=C is not decoration either: " +
      "`sort -k2` under a UTF-8 locale ignores punctuation and case on its first pass, which " +
      "reorders names like MarkupSafe-* and PySocks-* against the definition's bytewise order. " +
      "Both footguns are inherited from ENGINE-TREE.json, where each was reproduced, not predicted.",
    algorithm: "sha256-of-sorted-sha256-lines-v1",
    generated: new Date().toISOString().slice(0, 10),
    generatedBy: "scripts/fetch-swap-runtime.mjs",
    target: {
      platform: IS_WIN ? "win_amd64" : "manylinux_2_28_x86_64",
      pythonTag: "cp312",
      cpythonSource: IS_WIN ? "python.org embeddable" : "python-build-standalone (install_only)",
      abiNote:
        "A wheel tag names the MINOR version (cp312) and carries no micro field, so cp312 wheels " +
        "are NOT bound to a particular 3.12.x. An earlier version of this note claimed they were " +
        "and that moving CPython meant re-resolving every wheel; the filenames it described " +
        "disprove it. What the micro version does fix is the STDLIB shipped alongside, which is a " +
        "behaviour contract rather than an ABI one -- which is why Windows and Linux can run " +
        "3.12.10 and 3.12.14 against the same wheel set.",
      glibcFloor: IS_WIN
        ? null
        : "glibc 2.28+ (Debian 10+, Ubuntu 18.10+, RHEL 8+). Set by pyzmq's manylinux_2_28 wheel, " +
          "NOT by CPython -- the floor for the whole runtime is the strictest single wheel, so it " +
          "moves whenever any wheel is re-resolved.",
    },
    pins: {
      cpython: PIN_CPYTHON,
      basicswap: { tag: PIN_BASICSWAP_TAG, commit: PIN_BASICSWAP_COMMIT, version: "0.18.5" },
      coincurve: { tag: PIN_COINCURVE_TAG, commit: PIN_COINCURVE_COMMIT, version: "21.0.4", fork: true },
      cores: Object.fromEntries(COIN_CORES.map((c) => [c.coin, c.version])),
    },
    enginePatches: {
      dir: "upstream/patches",
      series: enginePatchSeries,
      note:
        "The staged basicswap wheel is built from the UNPATCHED pinned tag. The FULL patch " +
        "series must be applied to the source tree BEFORE building the wheel, or applied to " +
        "the installed package afterwards (node scripts/apply-engine-patches.mjs). `series` is " +
        "enumerated from upstream/patches/ at manifest time. See upstream/patches/README.md.",
    },
    gpgBypass: {
      why:
        "python-gnupg resolves 'gpg' from PATH only, and the Windows gpg.exe available here is " +
        "Git's MSYS2 build, which cannot take Windows paths (defect U-2). Upstream's core " +
        "verification therefore cannot run natively.",
      how:
        "This script fetches each coin release and verifies it against the sha256 pinned in its " +
        "table (each cross-checked against the upstream signed build-assert manifest when " +
        "recorded). The supervisor then calls prepare with --nocores --bindir=<out>/cores/<coin>, " +
        "so upstream neither downloads nor verifies anything.",
      doNotDo:
        "Do not 'fix' this by setting SKIP_GPG_VALIDATION and letting prepare fetch. That leaves " +
        "prepare pulling binaries over the network with only a manifest check and no pin under " +
        "review.",
    },
    assembly: {
      automated: false,
      why:
        "Assembling the image needs an external python with pip; the shipped runtime deliberately " +
        "has none. Keeping assembly out of this script keeps 'what are the inputs' answerable " +
        "separately from 'how is the image built'.",
      steps: IS_WIN
        ? WIN_ASSEMBLY_STEPS
        : [
            "tar xzf python/<cpython tar.gz> to <runtime> (it unpacks a `python/` prefix - strip it or point <runtime> at it).",
            "NO ._pth STEP. python-build-standalone is a normal prefix layout, not an embeddable one: isolation comes from `-s -E` at invocation, not from a path file. Do not invent a ._pth here.",
            "With an EXTERNAL python: python -m pip install --no-index --find-links <out>/wheels --target <runtime>/lib/python3.12/site-packages basicswap coincurve jinja2 markupsafe pycryptodome pysocks python-gnupg pyzmq websocket-client",
            "NOTE the site-packages path differs from Windows: lib/python3.12/site-packages - lowercase, version-qualified.",
            "Apply upstream/patches/*.patch to <runtime>/lib/python3.12/site-packages/basicswap (or build the wheel from a pre-patched tree).",
            "Delete <runtime>/lib/python3.12/site-packages/pip*, <runtime>/bin/pip*, and every __pycache__. Keep <runtime>/bin/python3.12 itself.",
            "Invoke only as: <runtime>/bin/python3 -s -E -m <module>",
            "UNVERIFIED: none of these steps has been executed. They are derived from the archive layout, not from a build that ran.",
          ],
      allNineNamedExplicitly:
        "Every distribution must be named on the install line. The basicswap wheel declares " +
        "dependencies = [], so `pip install basicswap` alone succeeds and then ImportErrors at " +
        "runtime.",
      noScriptsShims:
        "Never re-add Scripts/*.exe. Each console-script shim embeds the BUILD machine's absolute " +
        "interpreter path, so a relocated copy silently re-executes the ORIGINAL interpreter and " +
        "any relocation test run through a shim is a FALSE PASS.",
      referenceImage:
        ".swap-sidecar-work/runtime/RUNTIME-MANIFEST.json records the hand-built image this " +
        "recipe reproduces, including its verification gates.",
    },
    fileCount: artifacts.length,
    treeHash: tree,
    artifacts,
  };

  const manifestPath = path.join(OUT_DIR, "swap-runtime.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8" });

  console.log("");
  console.log(`${LOG} wrote ${manifestPath}`);
  console.log(`${LOG} fileCount ${artifacts.length}`);
  console.log(`${LOG} treeHash  ${tree}`);
  console.log(`${LOG} --- tree hash input lines ---`);
  process.stdout.write(lines.join(""));
  if (WARNINGS) console.log(`${LOG} completed with ${WARNINGS} warning(s).`);
  console.log(`${LOG} done. The stage dir is gitignored — never commit binaries.`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (CHECK_ONLY) return runCheck();
  return runFull();
}

main().catch((e) => {
  console.error(`${LOG} FAILED: ${e.message}`);
  process.exit(1);
});
