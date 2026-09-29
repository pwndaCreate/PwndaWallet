# 🧩 SOFTWARE PROJECT WIKI VAULT

## Bootstrap Initialization File · Version 1.0.0 (stack-agnostic)

> **Canonical filename: `wiki.md`.** Standalone handoff artifact. Drop it into the
> root of any coding project (rename to `wiki.md` if needed) and point a local AI
> agent at it. This file is its boot sequence. Language/framework-agnostic — works for
> Python, JS/TS, Go, Rust, Java, C#, Ruby, PHP, C/C++, mixed, or anything else.

---

<!--

╔══════════════════════════════════════════════════════════════════════════╗
║  🤖  AGENT BOOTSTRAP PROMPT — READ THIS ENTIRE FILE BEFORE DOING ANYTHING  ║
╚══════════════════════════════════════════════════════════════════════════╝

  This file (wiki.md) is a self-contained initialization script.

  When placed in a directory, it gives an AI agent everything it needs to build
  (or, for an existing project, reverse-engineer) a structured, Obsidian-compatible
  Markdown wiki vault that documents the codebase and stays in lock-step with it.

  ► You are FULLY AUTONOMOUS. Do NOT wait for user input to begin.
  ► FIRST decide whether this directory is EMPTY/NEW or ALREADY-SEEDED with code
    (STEP 0). Your entire boot path branches on that answer.
  ► Then execute ALL applicable steps in PART 1 immediately.
  ► Create EVERY file defined in PART 2 using the templates provided.
  ► During bootstrap you may READ existing source files freely, but you MUST NOT
    modify, move, or delete any pre-existing file. Vault creation is purely ADDITIVE
    (you only write inside the vault folders below).
  ► If the repo already has its own conventions (README, CONTRIBUTING, AGENTS.md,
    CLAUDE.md, .editorconfig, linters), those OVERRIDE this file's generic defaults.

-->

---

## 🆕 CORE PROTOCOLS (read me, agent)

This vault enforces four hard rules on top of the file structure:

1. **Project-state branching.** The boot path adapts to whether the directory is
   empty/new or already seeded with code. See **STEP 0** and **STEP 1.5**.
2. **Plan-First Protocol.** Every *long or very extensive* request requires a detailed,
   **timestamped** plan saved to `PLANS/` *before* any code is written. See
   **§ Plan-First Protocol** and `PLANS/PLAN-TEMPLATE.md`.
3. **The Wiki Synchronization Contract ("Never Stale").** After ANY modification to the
   project's file system, you MUST log it and update the wiki in the *same* unit of
   work. A task is not "done" until the wiki reflects reality. See **§ The Wiki
   Synchronization Contract** and the **Definition of Done**.
4. **Context-then-code review discipline.** Before acting you always (a) review the
   relevant wiki context, then (b) verify it against the *actual current code*,
   reconciling any drift. The wiki is the map; the code is the territory.

---

# ⚡ PART 1 — AGENT EXECUTION INSTRUCTIONS

You are an AI agent (Claude Code, Claude, or compatible) placed in a directory. This
file is your boot sequence. Read it completely, then execute every applicable step.

Your mission: **Build and perpetually maintain a structured, Obsidian-compatible
Markdown wiki vault that documents this software project** — its architecture, modules,
data models, public interfaces/APIs, dependencies, build/run/deploy ops, decisions,
bugs, plans, and session history — and keep it in lock-step with the code.

---

## ⏱️ TIMESTAMP STANDARD (used everywhere)

LLMs do not reliably know the current time. **Obtain the real timestamp at runtime**
before stamping anything:

```bash
# Linux / macOS / Git Bash
date -u +%Y-%m-%dT%H:%M:%SZ          # → 2026-06-14T14:32:05Z  (frontmatter / prose)
date -u +%Y%m%d-%H%M                  # → 20260614-1432         (filenames; no colons)
```

```powershell
# Windows PowerShell
(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
(Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmm")
```

- **Frontmatter / prose:** full ISO-8601 UTC, e.g. `2026-06-14T14:32:05Z`.
- **Filenames:** colon-free compact form, e.g. `20260614-1432` (Windows-safe).
- `[TIMESTAMP]` → real UTC timestamp. `[DATE]` → `YYYY-MM-DD` (UTC).
- Never invent a plausible-looking timestamp — obtain it, or ask the user once.

---

## STEP 0 — Detect Project State (DO THIS FIRST)

List the directory contents (excluding this `wiki.md` and `.git/`) and classify:

```bash
ls -A | grep -v -E '^(wiki\.md|\.git)$'
```

**Branch A — EMPTY / NEW** if there are no source files or build manifests (maybe just
a bare `README`, `LICENSE`, `.gitignore`).

**Branch B — SEEDED / ACTIVE** if you find any of:
- Source files: `*.py *.js *.ts *.tsx *.jsx *.go *.rs *.java *.kt *.rb *.php *.c *.cpp *.cs *.swift *.scala *.ex *.clj *.sh …`
- Build/dependency manifests: `package.json`, `pnpm-lock.yaml`/`yarn.lock`, `Cargo.toml`,
  `go.mod`, `pyproject.toml`/`requirements.txt`/`Pipfile`, `pom.xml`/`build.gradle`,
  `Gemfile`, `composer.json`, `*.csproj`/`*.sln`, `Makefile`, `CMakeLists.txt`, `mix.exs`
- An obvious source tree (`src/`, `lib/`, `app/`, `pkg/`, `cmd/`, `internal/`)

Record the result (you'll write it into `SETUP_COMPLETE.md` and the first CHANGELOG
entry). Then:
- **Branch A →** STEP 1, skip STEP 1.5, then STEP 2 → 6.
- **Branch B →** STEP 1, then **STEP 1.5 (Codebase Ingestion)**, then STEP 2 → 6.

> Before generating generic guidance, READ any existing `README*`, `CONTRIBUTING*`,
> `ARCHITECTURE*`, `AGENTS.md`, `CLAUDE.md`, `docs/`, `.editorconfig`, and linter/test
> configs. Treat them as authoritative; this bootstrap only *fills gaps*, never
> contradicts an existing house convention.

---

## STEP 1 — Create the Vault Directory Structure

```
_AGENT/                  ← agent config, changelog, tasks, plans live nearby
_DOCS/stack/             ← language/framework reference notes
_DOCS/external/          ← third-party library / service docs
ARCH/                    ← architecture & system design
ARCH/decisions/          ← ADRs (Architecture Decision Records)
CODE/modules/            ← per-module / package / component docs
CODE/services/           ← per-service / process / entrypoint docs
DATA/                    ← data models, schemas, migrations, storage contracts
API/                     ← public surface: endpoints, CLI, library API, integrations
DEPS/                    ← dependency + external-service inventory
OPS/                     ← build / test / run / deploy / config / env runbooks
TESTS/                   ← test strategy + coverage map
PLANS/                   ← timestamped plans for large requests
BUGS/active/
BUGS/resolved/
SESSIONS/
.obsidian/
```

Shell (Linux / macOS / Git Bash):
```bash
mkdir -p _AGENT _DOCS/stack _DOCS/external \
  ARCH ARCH/decisions CODE/modules CODE/services \
  DATA API DEPS OPS TESTS PLANS \
  BUGS/active BUGS/resolved SESSIONS .obsidian
```

Windows PowerShell:
```powershell
'_AGENT','_DOCS/stack','_DOCS/external','ARCH','ARCH/decisions',
'CODE/modules','CODE/services','DATA','API','DEPS','OPS','TESTS',
'PLANS','BUGS/active','BUGS/resolved','SESSIONS','.obsidian' |
  ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
```

---

## STEP 1.5 — Codebase Ingestion (BRANCH B ONLY — existing projects)

Read the existing code and reverse-engineer the wiki from the real current state.
Read-only — do not modify source.

### 1.5.1 — Detect the stack
- Identify language(s), framework(s), and tooling from manifests and file extensions.
- Record runtime/version constraints (engines, `rust-version`, `python_requires`, etc.).
- Identify the build system, package manager, test runner, linter/formatter, and CI.

### 1.5.2 — Map the code into the wiki (from reality, not assumptions)
- Fill `ARCH/architecture.md` (component map, layering, data-flow) from the real tree.
- For each significant module/package/service, create `CODE/modules/<name>.md` or
  `CODE/services/<name>.md` from `CODE/MODULE-TEMPLATE.md` — purpose, public API,
  dependencies (imports), what depends on it.
- Extract the **public surface** (HTTP routes, RPC/gRPC methods, CLI commands, exported
  library functions, events) into `API/api-surface.md`.
- Extract **data models / DB schemas / migrations / persisted formats** into
  `DATA/data-model.md` (these are the breaking-change-prone assets — track them).
- Inventory dependencies (from the manifest/lockfile) and external services into
  `DEPS/dependencies.md`.
- Capture build/test/run/deploy commands and required env vars into `OPS/runbook.md`.
- Note the current test layout and obvious coverage gaps into `TESTS/test-strategy.md`.

### 1.5.3 — Mark inferences clearly
Anything you inferred (not confirmed by the user or by explicit docs) gets tagged `wip`
plus: `> ⚠️ Inferred from code on [TIMESTAMP]; confirm intent with the user.`

### 1.5.4 — Record the baseline
- Write `SESSIONS/[DATE]-codebase-baseline.md` (what exists, what you documented, gaps).
- Add a CHANGELOG entry: `DOCS / Vault — Baseline ingestion (N modules, M endpoints, K deps).`
- Seed `_AGENT/TASKS.md` with a follow-up per gap (undocumented module, unclear data
  model, missing tests, suspected dead code, undocumented env var).

---

## STEP 2 — Stack Detection & Targeted Research

Research only what this project actually uses, and log findings under `_DOCS/`. Log each
fetch as a `RESEARCH` CHANGELOG entry.

1. **Primary language/runtime** → official docs + idioms/gotchas → `_DOCS/stack/stack-reference.md`.
2. **Framework(s)** (web/app/test/build) → key concepts, conventions, lifecycle → same file or a per-framework note.
3. **Key third-party libraries / external services** (the load-bearing ones from
   `DEPS/`) → purpose, the APIs this project calls, gotchas → `_DOCS/external/<lib>.md`.

> Where to find docs, by ecosystem (examples — adapt to the detected stack):
> npm → the package's README/registry + framework site; PyPI → project docs + readthedocs;
> crates.io → docs.rs; Go → pkg.go.dev; Maven Central → project Javadoc; etc.
> If offline, build the structure anyway and leave `_DOCS/` as skeletons + a task to fill.

---

## STEP 3 — Create All Vault Files
Create every file defined in PART 2. Replace `[PLACEHOLDER]`, `[DATE]`, `[TIMESTAMP]`.
Leave genuine *design/intent* placeholders for the user; in Branch B, fill *factual*
code/architecture/deps content from the real source.

## STEP 4 — Obsidian Configuration
Create `.obsidian/app.json` and `.obsidian/graph.json` from PART 3.

## STEP 5 — Confirm Setup Complete
Write `SETUP_COMPLETE.md`: detected branch (A/B) + evidence; init `[TIMESTAMP]`; full
file list; research summary (or errors if offline); for Branch B, what was ingested vs
still unknown; first recommended actions for the user.

## STEP 6 — Enter Ongoing Development Mode
For EVERY future request, run the Documentation Loop:
```
0. ORIENT     Read CHANGELOG (last 10), TASKS, scan BUGS/active
1. CHECK      Read the relevant wiki pages (ARCH/, CODE/, DATA/, API/, DEPS/)
2. VERIFY     Read the ACTUAL current code; reconcile drift (code wins → fix wiki)
3. RESEARCH   Fetch unknown APIs/patterns → log to _DOCS/
4. PLAN       List changes + blast radius. Big request → timestamped PLANS/ doc first
5. BUILD      Write or modify code (respect the repo's existing conventions/linters)
6. DOCUMENT   Update module/arch/data/api docs; add an ADR for notable decisions
7. LOG        Prepend a timestamped CHANGELOG entry
8. SESSION    Write SESSIONS/[DATE]-[topic].md
9. LINK       Cross-link all new pages with [[wikilinks]]
10. SYNC      Confirm the Definition of Done (wiki ≡ code) before declaring done
```

---

## 📐 § Plan-First Protocol (timestamped plans for big requests)

**A long or very extensive request requires a detailed, timestamped plan in `PLANS/`
BEFORE building.**

### What counts as "long or very extensive"? (trigger if ANY apply)
- Touches **3+ files/modules**, or any **cross-cutting / multi-component** change.
- Adds/removes a **module, service, public API, or data schema/migration**.
- A **refactor / migration / architecture change / dependency upgrade** with ripple.
- The user says *build / implement / overhaul / rework / redesign / migrate / from
  scratch / end-to-end*, or bundles several asks together.
- **> ~30 min** of work, several files, or any **breaking-change** potential
  (public API contract, DB schema, persisted format, env/config keys).

> Small, localized requests (one-line fix, single-file tweak, doc edit) don't need a
> `PLANS/` file — the inline PLAN step suffices. When unsure, write the plan.

### How to plan
1. Create `PLANS/PLAN-[YYYYMMDD-HHMM]-[topic].md` from the template; stamp it.
2. Fill: the request verbatim, scope, **relational blast radius** (what it touches and
   what could break), ordered steps, risks, rollback, verification checklist.
3. Link it from the active task and the session log.
4. Execute against it; tick steps; keep `status` current. On divergence, append a
   `## Revision [TIMESTAMP]` note (never silently rewrite). On completion → `completed`.

---

## 🔒 § The Wiki Synchronization Contract ("Never Stale")

**The wiki may never lag behind the code.** Wiki and codebase are two views of one
truth and may not diverge across a completed unit of work.

### The contract
- **Every** create/modify/delete/move of a source file is paired, in the *same* unit of
  work, with (1) a CHANGELOG entry and (2) updates to every wiki page describing the
  affected code/module/contract/schema.
- You may not end a turn/session having changed code without updating the wiki.
- Pre-existing drift (or a Branch-B gap) you touch is **yours to fix now**, not "later."
- The **code is authoritative.** When wiki and code disagree, update the wiki to match
  the code (if the *code* is wrong, that's a separate FIX with its own plan).

### Startup Freshness Audit (run at the start of every session)
1. Flag any source file modified more recently than its wiki doc:
   ```bash
   # heuristic: source changed in the last 7 days
   find . -path ./_* -prune -o -path ./.* -prune -o \
     \( -name '*.py' -o -name '*.ts' -o -name '*.go' -o -name '*.rs' -o -name '*.js' \) \
     -mtime -7 -print
   ```
2. Re-read each flagged file and update its `CODE/` doc (+ arch/data/api pages). Log a
   `DOCS` entry per repair.
3. Verify the **API surface** (`API/`) and **data-model** (`DATA/`) registries still
   match the code.
4. Drift you can't immediately resolve → raise a tracker flag + a task. Never leave it silent.

### ✅ Definition of Done (a task is NOT done until ALL are true)
- [ ] Code change complete and (where possible) verified to build/test/run.
- [ ] Every affected `CODE/`, `ARCH/`, `DATA/`, `API/`, `DEPS/`, `OPS/` page updated.
- [ ] A new `ARCH/decisions/ADR-####-*.md` for any notable architectural decision.
- [ ] `_AGENT/CHANGELOG.md` has a timestamped entry.
- [ ] `_AGENT/TASKS.md` updated (done checked, new added).
- [ ] If big request: its `PLANS/` doc is `completed`.
- [ ] A `SESSIONS/` log for this session exists/updated.
- [ ] New pages cross-linked with `[[wikilinks]]`.
- [ ] No remaining staleness flags (or each is ticketed).

---

## AGENT BEHAVIORAL RULES (active for all future sessions)

### ALWAYS
- Start each session: read CHANGELOG (last 10), TASKS, scan `BUGS/active/`, run the
  **Startup Freshness Audit**.
- Before acting: **review wiki context, then verify against the current code.**
- Long/extensive request → **timestamped `PLANS/` doc before building.**
- Follow the repo's existing conventions, linters, formatters, and test patterns.
- Document the **relational impact** of every change (what else it affects/breaks).
- Treat public APIs, data schemas, and config/env keys as **contracts** — changing one
  is a `BREAKING` change and needs a migration note.
- End every session with a `SESSIONS/` log; cross-link new pages; tag via YAML `tags:`.
- Satisfy the **Definition of Done** before declaring complete.

### NEVER
- Change code without logging to CHANGELOG and updating the wiki.
- Start a long/extensive build without a saved, timestamped plan.
- Leave the wiki describing something the code no longer does (no stale pages).
- Modify pre-existing source during the initial bootstrap (additive only).
- Assume a module works in isolation; skip the session log; or invent timestamps.
- Rename/repurpose a public API field, DB key, or env var without a BREAKING warning.

---

# 📁 PART 2 — VAULT FILE TEMPLATES

> Frontmatter required for Obsidian. `[PLACEHOLDER]` intent text is left for the user.

---

### 📄 FILE: _AGENT/claude.md

```
---
type: agent-config
agent: claude
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [agent, config, claude]
---

# 🤖 Claude Agent Configuration

## Identity & Role
You are a **Software Engineering Assistant** operating inside an Obsidian-compatible
wiki vault that documents this project. You help build, refactor, document, debug, and
ship code — and you keep this vault in lock-step with the code. The vault may NEVER go stale.

## Core Responsibilities
| Responsibility | Description |
|---|---|
| Context Review   | Read the wiki, THEN verify against current code, before acting |
| Planning         | Write timestamped plans for long/extensive requests |
| Code Development | Write, refactor, optimize per the repo's existing conventions |
| Documentation    | Maintain this wiki in real time as changes are made |
| Research         | Fetch + log language/framework/library docs |
| Architecture     | Record notable decisions as ADRs; keep the component map true |
| Debugging        | Identify, log, and resolve bugs with root-cause analysis |
| Change Mgmt      | Log every meaningful change; keep wiki ≡ code (never stale) |

## Session Startup Checklist
- [ ] Read `_AGENT/CHANGELOG.md` (last 10) and `_AGENT/TASKS.md`
- [ ] Scan `BUGS/active/`
- [ ] Read `OVERVIEW.md` + `ARCH/architecture.md` for current state
- [ ] Check `ARCH/dependency-tracker.md` if touching multi-module code
- [ ] Run the **Startup Freshness Audit** (code mtimes vs wiki; repair drift)

## Before Every Request — Context-then-Code Review (MANDATORY)
1. **Review wiki context** for the area in question.
2. **Verify against reality:** open the ACTUAL code the request touches. The wiki is the
   map; the code is the territory. On disagreement, code wins → fix the wiki + log `DOCS`.
3. **Decide plan depth:** long/extensive → create `PLANS/PLAN-[YYYYMMDD-HHMM]-[topic].md`
   and proceed only against it.

## Plan-First Trigger (write a timestamped PLANS/ doc when ANY apply)
- 3+ files, or any cross-cutting / multi-component change
- New/removed module, service, public API, or data schema/migration
- Refactor / migration / architecture change / dependency upgrade with ripple
- User says build / implement / overhaul / rework / redesign / migrate / from scratch
- > ~30 min, several files, or breaking-change potential

## Session End Checklist (Definition of Done)
- [ ] CHANGELOG updated (timestamped) for every change
- [ ] TASKS updated · new modules documented in `CODE/`
- [ ] `ARCH/`, `DATA/`, `API/`, `DEPS/`, `OPS/` updated as affected
- [ ] ADR added for notable decisions
- [ ] New bugs in `BUGS/active/`; fixed bugs → `BUGS/resolved/`
- [ ] Session summary in `SESSIONS/[DATE]-[topic].md`
- [ ] Any `PLANS/` doc for this work set to `completed`
- [ ] No staleness flags (wiki ≡ code)

## Code Standards (defer to the repo's own configs first)
- Match existing style; respect linters/formatters/`.editorconfig` already present.
- Public APIs, DB schemas, persisted formats, and env/config keys are **contracts** —
  changes are `BREAKING` and need a migration note in `DATA/` or `OPS/`.
- Prefer the project's established error-handling, logging, and testing patterns.
- Don't add dependencies casually; record any new one in `DEPS/dependencies.md`.

## Research Protocol
1. Search `_DOCS/` first. 2. If absent, fetch the official source. 3. Log to `_DOCS/`.
4. Cross-link from the relevant module/ADR. 5. Log a `RESEARCH` CHANGELOG entry.
```

---

### 📄 FILE: _AGENT/agent.md

```
---
type: agent-config
agent: general
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [agent, config, behavior]
---

# 🧠 General Agent Behavior Protocol

## Purpose
Universal protocol for ANY AI agent in this Software Project Wiki Vault — Claude, GPT,
Gemini, or other. Applies without exception. **The vault must always match the code.**

## The Documentation Loop (mandatory, every request)
```
0. ORIENT  Read CHANGELOG(10), TASKS, scan BUGS/active
1. CHECK   Read the relevant wiki pages (ARCH/CODE/DATA/API/DEPS)
2. VERIFY  Read the ACTUAL current code; reconcile drift (code wins → fix wiki)
3. RESEARCH  Fetch unknown APIs/patterns → log to _DOCS/
4. PLAN    List changes + blast radius. Big request → timestamped PLANS/ doc first
5. BUILD   Write/modify code per existing conventions
6. DOCUMENT  Update module/arch/data/api docs; ADR for notable decisions
7. LOG     Prepend a timestamped CHANGELOG entry
8. SESSION  Write SESSIONS/[DATE]-[topic].md
9. LINK    Cross-link all new pages with [[wikilinks]]
10. SYNC   Confirm Definition of Done — wiki ≡ code — before declaring done
```

## Two non-negotiables
1. **Plan-First for big work** — timestamped `PLANS/` doc before building.
2. **Never Stale** — after ANY file change, log it and update every affected wiki page,
   same unit of work. Code is authoritative; the wiki tracks it.

## Tagging Convention (frontmatter `tags:`)
| Tag | Usage | | Tag | Usage |
|---|---|---|---|---|
| agent | Agent config | | dependency | Dependency / external service |
| module | Module/package doc | | ops | Build/run/deploy/config |
| service | Service/process doc | | test | Test strategy/coverage |
| api | Public interface/contract | | session | Session log |
| data | Data model/schema/migration | | plan | Timestamped plan |
| adr | Architecture Decision Record | | reference | Language/lib reference |
| bug | Bug report | | continuity | Dependency/blast-radius flag |
| wip | Work in progress | | breaking | Breaking change warning |
| deprecated | Deprecated code/API | | | |

## File Naming Convention
| Type | Pattern | Example |
|---|---|---|
| Plan | `PLAN-YYYYMMDD-HHMM-topic.md` | `PLAN-20260614-1432-auth-refactor.md` |
| Session | `YYYY-MM-DD-topic.md` | `2026-06-14-auth-refactor.md` |
| Module doc | `<module-name>.md` (mirror source name) | `auth.md`, `PaymentService.md` |
| Bug report | `BUG-###-short-desc.md` | `BUG-014-token-refresh-race.md` |
| ADR | `ADR-####-short-title.md` | `ADR-0007-switch-to-postgres.md` |

## Wikilink Convention
`[[OVERVIEW]]`, `[[ARCH/architecture]]`, `[[CODE/modules/auth]]`,
`[[API/api-surface]]`, `[[DATA/data-model]]`, `[[BUG-014-token-refresh-race]]`,
`[[ADR-0007-switch-to-postgres]]`, `[[PLAN-20260614-1432-auth-refactor]]`.
Cross-linking is MANDATORY for: dependent modules, callers of an API, schema consumers,
bugs across components, plans driving sessions, and ADRs affecting modules.

## Relational Documentation Standard
Every significant entry answers:
► What does this do?  ► What does it depend on?  ► What depends on it?
► What breaks if it changes?  ► Which APIs / schemas / contracts does it touch?
```

---

### 📄 FILE: _AGENT/CHANGELOG.md

```
---
type: changelog
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [agent, changelog]
---

# 📋 CHANGELOG

> Single source of truth for all changes. Prepend an entry after EVERY meaningful
> change (Never-Stale rule). Newest at the TOP. Full UTC timestamps. Never delete rows.

## Change Type Reference
| Type | Meaning | | Type | Meaning |
|---|---|---|---|---|
| FEAT | New feature/module/capability | | DOCS | Documentation only |
| FIX | Bug fix | | TEST | Test added/changed |
| REFACTOR | Restructure, no behavior change | | DEPS | Dependency add/remove/upgrade |
| PERF | Performance change | | OPS | Build/CI/deploy/config |
| RESEARCH | Docs fetched + logged | | ADR | Decision recorded |
| BREAKING | Public API / schema / env contract change | | | |

---

## Log
| Timestamp (UTC) | Type | Scope | Description | Linked |
|---|---|---|---|---|
| [TIMESTAMP] | DOCS | Vault | Vault bootstrapped from wiki.md ([Branch A / Branch B]) | [[wiki]] |

---
*Prepend new rows to the top. Never delete. Link plans, sessions, ADRs, files.*
```

---

### 📄 FILE: _AGENT/TASKS.md

```
---
type: task-queue
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [agent, tasks]
---

# ✅ TASK QUEUE

## 🔴 Active — In Progress
| ID | Priority | Task | Session | Plan | Notes |
|---|---|---|---|---|---|
| T-001 | HIGH | Complete initial vault setup | Bootstrap | — | Auto-generated |

## 🟡 Backlog — Queued
| ID | Priority | Task | Source | Notes |
|---|---|---|---|---|
| T-002 | HIGH | Fill `OVERVIEW.md` (project purpose, goals, status) | User | Ask user |
| T-003 | HIGH | Document architecture in `ARCH/architecture.md` | Agent | From code (Branch B) |
| T-004 | MED | Inventory dependencies in `DEPS/dependencies.md` | Agent | From manifests |
| T-005 | MED | Capture build/test/run in `OPS/runbook.md` | Agent | From scripts/CI |

## ✅ Completed
| ID | Task | Timestamp | Session |
|---|---|---|---|
| — | — | — | — |

---
*Keep current. Add discovered tasks immediately. Mark done at session end.*
```

---

### 📄 FILE: PLANS/PLAN-TEMPLATE.md

```
---
type: plan
plan-id: PLAN-[YYYYMMDD-HHMM]-[topic]
title: [Short title]
created: [TIMESTAMP]
updated: [TIMESTAMP]
status: draft | approved | in-progress | completed | abandoned
estimated-scope: small | medium | large | epic
session: [[SESSIONS/[DATE]-[topic]]]
tags: [plan]
---

# 🗺️ PLAN — [Title]

> Created [TIMESTAMP]. Written BEFORE building because this is a long/extensive request.

## 1. User Request (verbatim)
> [...]

## 2. Goal & Success Criteria
- [Observable definition of done.]

## 3. Scope
**In scope:** [...]   **Out of scope:** [...]

## 4. Relational Blast Radius (what this touches / could break)
| Module / API / Schema / Config | How affected | Risk if wrong |
|---|---|---|
| `[[CODE/modules/...]]` | reads/writes/depends | 🔴/🟠/🟡/🟢 |
| API `[endpoint/method]` | contract change? | |
| Data `[table/schema]` | migration? BREAKING? | |
| Env/config `[KEY]` | new/renamed? | |

## 5. Step-by-Step Plan
- [ ] Step 1 — [action] (files: `...`)
- [ ] Step 2 — [action]
- [ ] TEST — [what tests to add/run]
- [ ] DOCUMENT — wiki pages to update: [...]
- [ ] LOG + SESSION + LINK — close out per Definition of Done

## 6. Risks & Mitigations
| Risk | Likelihood | Mitigation |
|---|---|---|

## 7. Rollback Plan
> How to revert if it breaks. [steps]

## 8. Verification Checklist
- [ ] Builds · [ ] Tests pass · [ ] Lint/format clean
- [ ] No public API / schema / env contract broken (or migration in place)
- [ ] Dependency tracker updated; no staleness flags
- [ ] CHANGELOG + session written

## 9. Revisions
> Append, never overwrite. `## Revision [TIMESTAMP] — [what changed & why]`
```

---

### 📄 FILE: OVERVIEW.md

```
---
type: project-overview
project: [PROJECT NAME]
status: in-development
primary-language: [e.g., TypeScript / Python / Go / Rust]
stack: [e.g., Node + React + Postgres]
repo: [URL or local]
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [project, overview]
---

# 🧩 Project Overview: [PROJECT NAME]

## What It Is
> [2–3 sentences. What does this project do? Who uses it? What problem does it solve?]

## Goals & Non-Goals
**Goals:** [...]   **Non-Goals:** [...]

## Tech Stack
| Layer | Tech | Notes |
|---|---|---|
| Language(s) | [...] | |
| Framework(s) | [...] | |
| Data store(s) | [...] | |
| Build / package mgr | [...] | |
| Test runner | [...] | |
| CI / deploy | [...] | |

## High-Level Architecture
> One paragraph + a pointer. Full detail in [[ARCH/architecture]].

## Key Components Status
| Component | Status | Wiki Link | Entry Point |
|---|---|---|---|
| [Core] | 🔴 Not Started | [[CODE/modules/core]] | `[path]` |

Legend: 🔴 Not Started · 🟡 In Progress · 🟢 Complete · 🔵 Live · ⚠️ Broken

## How to Run (summary)
> Full detail in [[OPS/runbook]].
```bash
# install / build / test / run
```

## Related
- [[ARCH/architecture]] · [[API/api-surface]] · [[DATA/data-model]]
- [[DEPS/dependencies]] · [[OPS/runbook]] · [[TESTS/test-strategy]]
- [[ARCH/dependency-tracker]] · [[_AGENT/CHANGELOG]]
```

---

### 📄 FILE: ARCH/architecture.md

```
---
type: architecture
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [architecture, overview]
---

# 🏗️ Architecture Overview

> High-level map of the system. MUST be updated whenever modules/services are added,
> removed, or restructured. In Branch B, populated from the REAL source.

## Component Map
```
[Entry point / app]
   ├── [Module A] ──► [Module B]
   ├── [Service X] ──► [Data store]
   └── [Module C] ──► [External API]
```

## Layering / Boundaries
> What layers exist (e.g., transport → domain → data) and the rules between them.

## Data Flow
```
[input] → [validation] → [domain logic] → [persistence] → [output]
```

## Module / Service Inventory
| Name | Kind | Path | Purpose | Status | Wiki |
|---|---|---|---|---|---|
| [core] | module | `src/...` | [...] | 🔴 | [[CODE/modules/core]] |

## Key Architectural Decisions
> Index of ADRs. Full records in `ARCH/decisions/`.
| ADR | Title | Status |
|---|---|---|
| [[ADR-0001-...]] | [...] | proposed/accepted/superseded |

## Cross-Cutting Concerns
> Auth, logging, error handling, config, observability, i18n — where each lives.

## Related
- [[ARCH/dependency-tracker]] · [[DATA/data-model]] · [[API/api-surface]] · [[DEPS/dependencies]]
```

---

### 📄 FILE: ARCH/dependency-tracker.md

```
---
type: dependency-tracker
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [continuity, dependencies, qa]
---

# 🔗 Dependency & Blast-Radius Tracker

> Cross-module dependency map + contract registries + consistency checker. Check and
> update before touching multi-module code, public APIs, or data schemas. This is the
> Never-Stale safety net — drift between wiki and code gets flagged here.

## Active Flags
| ID | Type | Description | Affects | Severity | Status |
|---|---|---|---|---|---|
| C-000 | Setup | Initial vault — no flags yet | — | 🟢 OK | Open |

Severity: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low/OK

## Module Dependency Map (blast radius)
```
[Module A]
   ↓ used by
[Module B] ←→ [Module C]
   ↓ calls
[External Service / DB]
```

## Public API / Interface Contract Registry
> If a contract changes, raise a flag + a BREAKING changelog entry. Mirror into [[API/api-surface]].
| Interface | Kind (HTTP/RPC/CLI/lib) | Provided By | Consumed By | Contract/Shape | Status |
|---|---|---|---|---|---|

## Data Schema / Storage Key Registry
> NEVER rename a column/key/field without a migration strategy. Mirror into [[DATA/data-model]].
| Name | Store | Schema/Shape | Used By | Notes |
|---|---|---|---|---|

## Config / Env Var Registry
> Renaming or removing a key is BREAKING for deploys.
| Key | Where Read | Required? | Default | Notes |
|---|---|---|---|---|

## Pre-Change Checklist (run before any major change)
- [ ] No public API/interface contract changed (or BREAKING flagged + migration)
- [ ] No DB schema / persisted key renamed (or migration in place)
- [ ] No env/config key renamed/removed silently
- [ ] No circular import / dependency cycle introduced
- [ ] Affected callers updated; tests cover the change
- [ ] CHANGELOG updated; affected wiki pages updated (no staleness)
```

---

### 📄 FILE: ARCH/decisions/ADR-TEMPLATE.md

```
---
type: adr
adr-id: ADR-0000
title: [Short decision title]
status: proposed | accepted | superseded | deprecated
created: [TIMESTAMP]
updated: [TIMESTAMP]
supersedes: []
superseded-by: []
tags: [adr, decision]
---

# 📐 ADR-[####]: [Title]

## Status
[proposed | accepted | superseded by [[ADR-####-...]]]

## Context
> The problem/forces. Why a decision is needed now.

## Decision
> What we decided to do.

## Alternatives Considered
| Option | Pros | Cons | Why not |
|---|---|---|---|

## Consequences
> Positive, negative, and follow-on work. What this constrains going forward.

## Affected
- Modules: [[CODE/modules/...]]
- APIs / schemas: [[API/api-surface]] / [[DATA/data-model]]
```

---

### 📄 FILE: CODE/MODULE-TEMPLATE.md

```
---
type: module-doc
module: [name]
kind: module | package | service | component | library
path: [src/...]
language: [...]
status: planned | active | deprecated
created: [TIMESTAMP]
updated: [TIMESTAMP]
last-session: [[SESSIONS/[DATE]-topic]]
tags: [module]
---

# 📦 [Module Name]

## Purpose
> One or two sentences. What it does and why it exists.

## Public API / Surface
> Exported functions/types/classes, routes, CLI commands, or events others rely on.
```text
[signature] — [what it does]
```

## Internal Design
> How it works; key decisions (link ADRs); important invariants.

## Dependencies
| Dependency | Type | Why Needed |
|---|---|---|
| `[[CODE/modules/other]]` | internal | [...] |
| `[external-lib]` | external | [...] |
| `[service/DB]` | infra | [...] |

## Depended On By
| Consumer | How it uses this |
|---|---|

## Data / State
| Name | Type | Scope | Description |
|---|---|---|---|

## Affects (blast radius if changed)
| System | How | Severity if Broken |
|---|---|---|

## Known Issues / Edge Cases
| Issue | Severity | Ticket | Notes |
|---|---|---|---|

## Change History
| Timestamp | Type | Description | Session |
|---|---|---|---|
| [TIMESTAMP] | FEAT | Created/documented | [[SESSIONS/[DATE]-topic]] |

> Copy to `CODE/modules/<name>.md` (or `CODE/services/<name>.md`) per module.
```

---

### 📄 FILE: DATA/data-model.md

```
---
type: data-model
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [data, schema]
---

# 🗄️ Data Model & Schemas

> Persisted data, DB schemas, serialization formats, and migrations. These are
> breaking-change-prone — keep this registry exact and mirror it in [[ARCH/dependency-tracker]].

## Stores / Datastores
| Store | Tech | Purpose | Notes |
|---|---|---|---|

## Entities / Tables / Collections
### [Entity]
| Field | Type | Constraints | Description |
|---|---|---|---|
> Relationships: [...]   Indexes: [...]

## Serialization / Wire Formats
> JSON shapes, protobufs, persisted file formats, cache keys.

## Migrations
| Version | Date | Change | Reversible? | Notes |
|---|---|---|---|---|

## ⚠️ Breaking-Change Watch
> Renaming a field/key/column or changing a type is BREAKING. Record the migration path.
```

---

### 📄 FILE: API/api-surface.md

```
---
type: api-surface
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [api]
---

# 🔌 Public API Surface

> Everything other code/users depend on: HTTP/RPC endpoints, CLI commands, exported
> library functions, events. A change here is a contract change — mirror into
> [[ARCH/dependency-tracker]] and flag BREAKING if the shape changes.

## HTTP / RPC Endpoints
| Method+Path | Auth | Request | Response | Handler | Status |
|---|---|---|---|---|---|

## CLI Commands (if any)
| Command | Args/Flags | Effect | Entry |
|---|---|---|---|

## Exported Library API (if a library)
| Symbol | Signature | Stability | Notes |
|---|---|---|---|

## Events / Messages (if any)
| Event | Producer | Consumers | Payload |
|---|---|---|---|

## Integration Points (outbound)
| External Service | Used By | Endpoint | Auth | Notes |
|---|---|---|---|---|
```

---

### 📄 FILE: DEPS/dependencies.md

```
---
type: dependencies
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [dependency]
---

# 📚 Dependencies & External Services

> Inventory of third-party libraries and external services. Update on every add /
> remove / upgrade (CHANGELOG type `DEPS`). Document the load-bearing ones in `_DOCS/external/`.

## Runtime Dependencies
| Package | Version | Why Used | Used By | Docs |
|---|---|---|---|---|

## Dev / Build Dependencies
| Package | Version | Purpose |
|---|---|---|

## External Services / APIs
| Service | Purpose | Auth/Secrets | Owner | Notes |
|---|---|---|---|---|

## Upgrade / Risk Notes
> Pinned versions, known-risky deps, deprecation watch, license concerns.
```

---

### 📄 FILE: OPS/runbook.md

```
---
type: runbook
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [ops]
---

# ⚙️ Build / Run / Deploy Runbook

> How to build, test, run, and deploy. Keep commands accurate — verify against the
> repo's scripts/CI in Branch B.

## Prerequisites
| Tool | Version | Notes |
|---|---|---|

## Common Commands
```bash
# install
# build
# test
# lint / format
# run (dev)
# run (prod)
```

## Environment Variables / Config
| Key | Required? | Default | Description | Where Read |
|---|---|---|---|---|

## CI / CD
> Pipeline stages, where it's defined, what gates a merge/release.

## Deploy
> Targets, steps, rollback procedure.

## Troubleshooting
| Symptom | Likely Cause | Fix |
|---|---|---|
```

---

### 📄 FILE: TESTS/test-strategy.md

```
---
type: test-strategy
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [test]
---

# 🧪 Test Strategy & Coverage Map

## Approach
> Unit / integration / e2e split; frameworks; what's mocked; conventions.

## How to Run
```bash
# all / subset / watch / coverage
```

## Coverage Map
| Area / Module | Test Type | Location | Status | Gaps |
|---|---|---|---|---|

## Known Gaps / Flaky Tests
| Item | Risk | Notes |
|---|---|---|
```

---

### 📄 FILE: _DOCS/stack/stack-reference.md

```
---
type: language-reference
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [reference, stack]
---

# 📘 Stack Reference

> Notes on the project's primary language(s)/framework(s): idioms, conventions, gotchas,
> and the specific APIs this project uses. Append as you learn. Cite official sources.

## Language: [name + version]
- Idioms / style this project follows:
- Gotchas:
- Official docs:

## Framework: [name]
- Core concepts / lifecycle:
- Project-specific conventions:
- Official docs:

*Append patterns and gotchas as discovered during development.*
```

---

### 📄 FILE: _DOCS/external/libraries.md

```
---
type: api-documentation
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [reference, external]
---

# 🧩 External Library Notes

> One section per load-bearing third-party library: what it's for, the APIs this
> project calls, and gotchas. Prioritize libraries actually in use (from [[DEPS/dependencies]]).

| Library | Purpose | Version | Docs | Notes |
|---|---|---|---|---|
```

---

### 📄 FILE: BUGS/active/BUG-TEMPLATE.md

```
---
type: bug-report
bug-id: BUG-000
title: [Short title]
severity: critical | high | medium | low
status: open | investigating | in-progress | needs-testing | resolved
affected-modules: []
reported: [TIMESTAMP]
reported-session: [[SESSIONS/[DATE]-topic]]
updated: [TIMESTAMP]
tags: [bug]
---

# 🐛 BUG-[###]: [Short Title]

## Summary
**Expected:** [...]   **Actual:** [...]
**Frequency:** Always / Intermittent / Rare / Only when: [condition]
**Environment:** [OS / version / config]
**Discovered in:** [[SESSIONS/[DATE]-topic]]

## Severity
🔴 Critical (data loss / outage) · 🟠 High · 🟡 Medium (workaround) · 🟢 Low (cosmetic)
**This bug is:** [LEVEL]

## Steps to Reproduce
1. [...] 2. [...] 3. [observe]

## Affected Systems
| Module / API / Data | How Affected |
|---|---|

## Root Cause Analysis
[Diagnosis, or blank]

## Fix Plan
[Plan, or link to [[PLAN-...]] if non-trivial]

## Fix Applied (then move to BUGS/resolved/)
```diff
- before
+ after
```
**Resolved:** [TIMESTAMP] · **Session:** [[SESSIONS/[DATE]-topic]] · **Commit/PR:** [ref]

## Related
- [[related-bug]] · [[related-module]]
```

---

### 📄 FILE: SESSIONS/SESSION-TEMPLATE.md

```
---
type: session-log
date: [DATE]
started: [TIMESTAMP]
ended: [TIMESTAMP]
topic: [main focus]
agent: claude | [other]
user-request: [brief summary]
plan: [[PLANS/PLAN-...]]   # if a plan drove this session
tags: [session]
---

# 📓 Session — [DATE]: [Topic]

## User's Request
> [Exact or paraphrased ask.]

## Plan Reference
> [[PLANS/PLAN-...]] (if long/extensive) — or "small request, no formal plan".

## Objective
1. [Goal 1] 2. [Goal 2]

## Work Completed
| Task | Outcome | Files |
|---|---|---|
| [...] | ✅/⚠️/❌ | `path` |

## Code Changes
### ✨ Added   ### 🔧 Modified   ### 🗑️ Removed / Deprecated

## Research & Discoveries
> New APIs/patterns; log substantial ones to `_DOCS/`.

## Bugs Encountered
| Bug ID | Description | Severity | Status |
|---|---|---|---|

## Decisions
> Notable choices → did any warrant an ADR? Link it: [[ADR-####-...]]

## Wiki Sync Confirmation (Definition of Done)
- [ ] CHANGELOG  - [ ] module/arch/data/api docs  - [ ] dependency tracker
- [ ] ADR (if needed)  - [ ] plan → completed  - [ ] no staleness flags

## Next Session Priorities
1. [...] 2. [...] 3. [...]

## Notes
> Decisions, rationale, user feedback.
```

---

# ⚙️ PART 3 — OBSIDIAN CONFIGURATION

### 📄 FILE: .obsidian/app.json

```json
{
  "useMarkdownLinks": false,
  "newFileLocation": "current",
  "newFileFolderPath": "",
  "readableLineLength": true,
  "strictLineBreaks": false,
  "showLineNumber": true,
  "spellcheck": false,
  "livePreview": true,
  "defaultViewMode": "source"
}
```

### 📄 FILE: .obsidian/graph.json

```json
{
  "collapse-filter": false,
  "search": "",
  "showTags": true,
  "showAttachments": false,
  "hideUnresolved": false,
  "showOrphans": true,
  "colorGroups": [
    {"query": "tag:#bug",        "color": {"a": 1, "rgb": 16007990}},
    {"query": "tag:#module",     "color": {"a": 1, "rgb": 3394764}},
    {"query": "tag:#api",        "color": {"a": 1, "rgb": 16744272}},
    {"query": "tag:#data",       "color": {"a": 1, "rgb": 10053222}},
    {"query": "tag:#adr",        "color": {"a": 1, "rgb": 16769792}},
    {"query": "tag:#session",    "color": {"a": 1, "rgb": 6737151}},
    {"query": "tag:#plan",       "color": {"a": 1, "rgb": 65407}},
    {"query": "tag:#dependency", "color": {"a": 1, "rgb": 8388863}},
    {"query": "tag:#ops",        "color": {"a": 1, "rgb": 16729156}},
    {"query": "tag:#test",       "color": {"a": 1, "rgb": 11206655}}
  ],
  "showArrow": true,
  "nodeSizeMultiplier": 1,
  "lineSizeMultiplier": 1,
  "linkDistance": 250,
  "scale": 1
}
```

---

# 🗺️ PART 4 — AGENT QUICK REFERENCE

## The Documentation Loop (every request)
```
ORIENT → CHECK(wiki) → VERIFY(code) → RESEARCH → PLAN* → BUILD
       → DOCUMENT → LOG → SESSION → LINK → SYNC-CHECK
       (*timestamped PLANS/ doc for long/extensive requests)
```

## The Two Imperatives
1. **Plan-First:** big request → `PLANS/PLAN-[YYYYMMDD-HHMM]-topic.md` BEFORE building.
2. **Never Stale:** every code change → CHANGELOG entry + updated wiki, same unit of work.

## Definition of Done
Code builds/tests · all affected `CODE/ARCH/DATA/API/DEPS/OPS` pages updated · ADR for
notable decisions · CHANGELOG entry · TASKS updated · PLAN completed · SESSION written ·
`[[wikilinks]]` added · no staleness flags.

## Startup Freshness Audit
Compare source mtimes vs wiki docs → repair anything code-newer-than-doc → verify API +
data-model registries match code → ticket anything unresolved.

## Pre-Change Checklist (multi-module / contract changes)
- [ ] Public API/interface contracts unchanged (or BREAKING flagged + migration)
- [ ] DB schema / persisted keys unchanged (or migration in place)
- [ ] Env/config keys unchanged (or documented)
- [ ] No new dependency cycles · [ ] Tests cover the change · [ ] Tracker updated

## Vault Navigation Map
| I need to... | Go to... |
|---|---|
| Understand the project | [[OVERVIEW]] |
| See the architecture | [[ARCH/architecture]] |
| Cross-module deps / contracts | [[ARCH/dependency-tracker]] |
| Read decisions | `ARCH/decisions/` (ADRs) |
| A specific module | `CODE/modules/` or `CODE/services/` |
| Data models / schemas | [[DATA/data-model]] |
| Public API surface | [[API/api-surface]] |
| Dependencies / services | [[DEPS/dependencies]] |
| Build/run/deploy | [[OPS/runbook]] |
| Test strategy | [[TESTS/test-strategy]] |
| Active plans | `PLANS/` |
| Recent changes | [[_AGENT/CHANGELOG]] |
| Active tasks | [[_AGENT/TASKS]] |
| Active bugs | `BUGS/active/` |
| Past sessions | `SESSIONS/` |
| Stack / library notes | [[_DOCS/stack/stack-reference]] · [[_DOCS/external/libraries]] |

## Severity & Status Scales
Bugs/flags: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low/OK
Status: 🔴 Not started · 🟡 In progress · 🟢 Complete · 🔵 Live · ⚠️ Broken · 🗄️ Deprecated

---

*This vault was bootstrapped from wiki.md — Software Project Wiki v1.0.0 (stack-agnostic).*
*To re-run setup or update structure, edit wiki.md and re-execute PART 1.*
*Core laws: (1) review wiki then verify code before acting, (2) plan big work with
timestamps first, (3) never let the wiki go stale, (4) honor the repo's own conventions.*
