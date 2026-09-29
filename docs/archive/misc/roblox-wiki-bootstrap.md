# 🎮 ROBLOX GAME DEVELOPMENT WIKI VAULT

## Bootstrap Initialization File · Version 2.0.0

> **Canonical filename: `wiki.md`.** This is a standalone handoff artifact. Drop it
> into the root of your game project directory (rename to `wiki.md` if needed) and
> point a local AI agent at it. This file is its boot sequence.

---

<!--

╔══════════════════════════════════════════════════════════════════════════╗
║  🤖  AGENT BOOTSTRAP PROMPT — READ THIS ENTIRE FILE BEFORE DOING ANYTHING  ║
╚══════════════════════════════════════════════════════════════════════════╝

  This file (wiki.md) is a self-contained initialization script.

  When placed in a directory, it gives an AI agent everything it needs to
  build (or, for an existing project, reverse-engineer) a fully structured
  Roblox game-development wiki vault.

  ► You are FULLY AUTONOMOUS. Do NOT wait for user input to begin.
  ► FIRST decide whether this directory is EMPTY/NEW or ALREADY-SEEDED with
    code (STEP 0). Your entire boot path branches on that answer.
  ► Then execute ALL applicable steps in PART 1 immediately.
  ► Create EVERY file defined in PART 2 using the templates provided.
  ► During bootstrap you may READ existing game/source files freely, but you
    MUST NOT modify, move, or delete any pre-existing source file. Vault
    creation is purely ADDITIVE. (You only write inside the vault folders.)

-->

---

## 🆕 WHAT'S NEW IN v2.0.0 (read me, agent)

This version adds four hard requirements on top of the v1 structure:

1. **Project-state branching.** The boot path adapts to whether the directory is
   empty/new or already seeded with code. See **STEP 0** and **STEP 1.5**.
2. **Plan-First Protocol.** Every *long or very extensive* user request requires a
   detailed, **timestamped** plan saved to `PLANS/` *before* any code is written.
   See **§ Plan-First Protocol** and `PLANS/PLAN-TEMPLATE.md`.
3. **The Wiki Synchronization Contract ("Never Stale").** After ANY modification to
   the game's file system, you MUST log it and update the wiki in the *same* unit of
   work. A task is not "done" until the wiki reflects reality. See **§ The Wiki
   Synchronization Contract** and the **Definition of Done**.
4. **Context-then-code review discipline.** Before acting you always (a) review
   relevant wiki context, then (b) verify it against the *actual current code state*,
   reconciling any drift. The wiki is the map; the code is the territory. Baked into
   `_AGENT/claude.md`, `_AGENT/agent.md`, and the Documentation Loop.

---

# ⚡ PART 1 — AGENT EXECUTION INSTRUCTIONS

You are an AI agent (Claude Code, Claude, or compatible) that has just been placed in
a directory. This file is your boot sequence. Read it completely, then execute every
applicable step below in order.

Your mission: **Build and perpetually maintain a structured, Obsidian-compatible
Markdown wiki vault for Roblox game development.** This vault is the single source of
truth for code, game mechanics, story/lore, UX design, bugs, patches, plans, and
session history for one or more Roblox games.

---

## ⏱️ TIMESTAMP STANDARD (used everywhere)

LLMs do not reliably know the current time. **Obtain the real timestamp at runtime**
before stamping anything:

```bash
# Linux / macOS / Git Bash
date -u +%Y-%m-%dT%H:%M:%SZ          # → 2026-06-07T14:32:05Z   (use in frontmatter/body)
date -u +%Y%m%d-%H%M                  # → 20260607-1432          (use in filenames; no colons)
```

```powershell
# Windows PowerShell
(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
(Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmm")
```

- **In frontmatter and prose:** full ISO-8601 UTC, e.g. `2026-06-07T14:32:05Z`.
- **In filenames:** colon-free compact form, e.g. `20260607-1432` (Windows-safe).
- Wherever a template says `[TIMESTAMP]`, substitute a real UTC timestamp.
- Wherever a template says `[DATE]`, substitute `YYYY-MM-DD` (UTC).
- If you genuinely cannot run a shell command, ask the user for the current
  UTC date/time once and reuse it — never invent a plausible-looking timestamp.

---

## STEP 0 — Detect Project State (DO THIS FIRST)

Before creating anything, determine which world you are in. List the directory
contents (excluding this `wiki.md` and any `.git/`) and classify:

```bash
ls -A | grep -v -E '^(wiki\.md|\.git)$'
```

**Branch A — EMPTY / NEW project** if the directory contains no game source files
(no `.lua`/`.luau`, no `.rbxl`/`.rbxlx`, no `default.project.json`/Rojo config, no
`src/` of scripts, etc.). Maybe a bare `README`, `LICENSE`, or `.gitignore` — still
counts as empty for our purposes.

**Branch B — SEEDED / ACTIVE project** if you find any of:
- Luau/Lua source: `*.lua`, `*.luau`
- Rojo / tooling: `default.project.json`, `*.project.json`, `rojo.json`, `wally.toml`,
  `aftman.toml`, `rokit.toml`, `.luaurc`, `selene.toml`, `stylua.toml`
- Roblox place/model files: `*.rbxl`, `*.rbxlx`, `*.rbxm`, `*.rbxmx`
- An obvious source tree (`src/`, `Packages/`, `ServerScriptService/`, etc.)

Record the result — you will write it into `SETUP_COMPLETE.md` and the first
`CHANGELOG` entry. Then:

- **Branch A →** do STEP 1, skip STEP 1.5, then STEP 2 → 6.
- **Branch B →** do STEP 1, then **STEP 1.5 (Codebase Ingestion)**, then STEP 2 → 6.

> ⚠️ Binary `.rbxl` files cannot be parsed as text. `.rbxlx`/`.rbxmx` are XML and are
> partially readable. If the ONLY game content is a binary `.rbxl` (no source on disk),
> note in `SETUP_COMPLETE.md` that full ingestion needs the user to sync the place to
> source via **Rojo** (`rojo sourcemap` / `rojo build`) or export scripts; build the
> empty-project structure (Branch A) in the meantime and file a HIGH task in
> `_AGENT/TASKS.md` to ingest once source is available.

---

## STEP 1 — Create the Vault Directory Structure

Create the following directory tree in the current working directory:

```
_AGENT/
_DOCS/roblox-api/
_DOCS/luau/
_DOCS/external/
GAME/mechanics/
GAME/story/
GAME/ux/
GAME/continuity/
CODE/scripts/
CODE/modules/
CODE/services/
CODE/architecture/
PLANS/                  ← NEW: timestamped plans for large requests
BUGS/active/
BUGS/resolved/
PATCHES/
SESSIONS/
ASSETS/concepts/
ASSETS/maps/
.obsidian/
```

Shell command (Linux / macOS / Git Bash):

```bash
mkdir -p _AGENT _DOCS/roblox-api _DOCS/luau _DOCS/external \
  GAME/mechanics GAME/story GAME/ux GAME/continuity \
  CODE/scripts CODE/modules CODE/services CODE/architecture \
  PLANS BUGS/active BUGS/resolved PATCHES SESSIONS \
  ASSETS/concepts ASSETS/maps .obsidian
```

Windows PowerShell:

```powershell
'_AGENT','_DOCS/roblox-api','_DOCS/luau','_DOCS/external',
'GAME/mechanics','GAME/story','GAME/ux','GAME/continuity',
'CODE/scripts','CODE/modules','CODE/services','CODE/architecture',
'PLANS','BUGS/active','BUGS/resolved','PATCHES','SESSIONS',
'ASSETS/concepts','ASSETS/maps','.obsidian' |
  ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
```

---

## STEP 1.5 — Codebase Ingestion (BRANCH B ONLY — existing/seeded projects)

You landed in a project that already has code. **Before writing any documentation,
read the existing code and reverse-engineer the wiki from the real current state.**
This is read-only — do not modify source.

### 1.5.1 — Inventory the source tree
- Enumerate every source file (`*.lua`, `*.luau`, and XML `*.rbxlx`/`*.rbxmx` if present).
- Detect the project layout / tooling (Rojo `default.project.json` maps folders →
  Roblox services; `wally.toml`/`Packages/` reveal community deps).
- Build a file → Roblox-hierarchy mapping (e.g. `src/server/*` → `ServerScriptService`).

### 1.5.2 — Populate the architecture wiki from reality
- Fill `CODE/architecture.md` **Script Inventory** and **Module Map** from the actual
  files you found — not from assumptions.
- For each *significant* script/module, create a `CODE/scripts/<Name>.md` (or
  `CODE/modules/<Name>.md`) from `CODE/scripts/SCRIPT-TEMPLATE.md`, filled from the
  real code: purpose, type, location, dependencies (`require()` targets), events.
- Extract every `RemoteEvent`/`RemoteFunction`/`BindableEvent` you can find into the
  **RemoteEvent Contract Registry** in both `CODE/architecture.md` and
  `GAME/continuity/tracker.md`.
- Extract every `DataStore`/`MemoryStore` key/name into the **DataStore Key Registry**
  in `GAME/continuity/tracker.md`.
- Detect community libraries in use (Knit, ProfileService/ProfileStore, Roact/Fusion,
  Janitor/Maid, Signal, etc.) and note them in `_DOCS/external/community-libraries.md`.

### 1.5.3 — Infer mechanics & systems (mark inferences clearly)
- Where the code obviously implements a mechanic (movement, combat, shop, leaderboard,
  inventory…), create a stub `GAME/mechanics/<name>.md` from the template.
- **Tag anything you inferred (not confirmed by the user) with `wip` and a line:
  `> ⚠️ Inferred from code on [TIMESTAMP]; confirm intent with the user.`** Never
  fabricate story/lore — leave `GAME/story/lore-bible.md` as placeholders for the user.

### 1.5.4 — Record the baseline
- Write a baseline session: `SESSIONS/[DATE]-codebase-baseline.md` summarizing what
  exists, what you documented, and what's still unknown.
- Add a `CHANGELOG` entry of type `DOCS` / scope `Vault`:
  *"Baseline ingestion of existing codebase (N scripts, M modules, K RemoteEvents)."*
- Seed `_AGENT/TASKS.md` with follow-ups for every gap (undocumented script, unclear
  mechanic, missing tests, suspected dead code).

---

## STEP 2 — Research & Documentation Fetch

Perform the following research tasks and log all findings into the appropriate
`_DOCS/` files (templates provided in PART 2). Log every fetch as a `RESEARCH`
entry in `_AGENT/CHANGELOG.md`.

### 2.1 — Roblox Creator Hub
Fetch and summarize documentation from:
- https://create.roblox.com/docs                    → General overview
- https://create.roblox.com/docs/reference/engine   → Engine API reference
- https://create.roblox.com/docs/scripting/luau     → Luau scripting guide
- https://create.roblox.com/docs/scripting/services  → Core Roblox services

Log into: `_DOCS/roblox-api/roblox-api-log.md`

### 2.2 — Luau Language Reference
Fetch and summarize from https://luau.org, focusing on: type annotations & gradual
typing; string interpolation (backtick literals); the `task` library
(`task.spawn`/`delay`/`defer`/`wait`); the `buffer` library; generics, compound
assignment, `continue`; differences from Lua 5.1.

Log into: `_DOCS/luau/luau-reference.md`

### 2.3 — Key Roblox Services to Document
Document each with purpose, key methods, key events, and gotchas:

| Service | Category | | Service | Category |
|---|---|---|---|---|
| ReplicatedStorage | Architecture | | HttpService | External web APIs |
| ServerStorage | Architecture | | MessagingService | Cross-server comms |
| ServerScriptService | Architecture | | PathfindingService | NPC AI |
| DataStoreService | Persistence | | CollectionService | Object tagging |
| MemoryStoreService | Persistence | | MarketplaceService | Monetization |
| TweenService | Animation | | SoundService | Audio |
| RunService | Core loop | | Lighting | Environment |
| UserInputService | Input | | RemoteEvent / RemoteFunction | Networking |
| Players | Player management | | BindableEvent / BindableFunction | Internal |

### 2.4 — Community Libraries to Research & Log
- **Knit** (service/component framework) — https://sleitnick.github.io/Knit/
- **ProfileService / ProfileStore** (DataStore wrapper, session locking)
- **Roact / Fusion** (declarative UI)
- **Janitor / Maid** (cleanup / memory management)
- **Signal** (custom event implementation)

Log into: `_DOCS/external/community-libraries.md`

> In Branch B, prioritize researching the libraries you actually found in use first.

---

## STEP 3 — Create All Vault Files

Create every file defined in PART 2 of this document. Each file is marked with:

  `### 📄 FILE: path/to/filename.md`

Use the content block immediately following that header. Replace `[PLACEHOLDER]`,
`[DATE]`, and `[TIMESTAMP]` appropriately. **Do not fabricate game details** — leave
genuine `[PLACEHOLDER]` design content for the user to fill in. (In Branch B, fill the
*code/architecture* facts from the real source; still leave *design/story* placeholders.)

---

## STEP 4 — Obsidian Configuration

Create `.obsidian/app.json` and `.obsidian/graph.json` as defined in PART 3.

---

## STEP 5 — Confirm Setup Complete

Write `SETUP_COMPLETE.md` in the vault root containing:
- **Detected project state** (Branch A empty / Branch B seeded) and the evidence.
- Timestamp of initialization (`[TIMESTAMP]`).
- Full list of all files created.
- Summary of documentation fetched (or errors if fetch failed / offline).
- For Branch B: a summary of what was ingested and what remains unknown.
- First recommended actions for the user.

---

## STEP 6 — Enter Ongoing Development Mode

After setup you are in **Roblox Game Development Wiki Mode.** For EVERY future user
request, run the Documentation Loop:

```
0. ORIENT     → Read _AGENT/CHANGELOG.md (last 10), _AGENT/TASKS.md, scan BUGS/active/
1. CHECK      → Read the relevant wiki pages (GAME/, CODE/, continuity, mechanics)
2. VERIFY     → Open the ACTUAL current code the request touches; reconcile any
                drift between wiki and code (code wins → fix the wiki immediately)
3. RESEARCH   → If unfamiliar API/pattern, fetch + log to _DOCS/
4. PLAN       → Identify what changes + blast radius. For a LONG/EXTENSIVE request,
                write a timestamped PLANS/ doc and proceed only against it.
5. BUILD      → Write or modify code / content
6. DOCUMENT   → Update script docs, mechanic pages, story/continuity, architecture
7. LOG        → Prepend an entry to _AGENT/CHANGELOG.md (timestamped)
8. SESSION    → Write/update SESSIONS/[DATE]-[topic].md
9. LINK       → Ensure all new/changed pages have [[wikilinks]] to related pages
10. SYNC-CHECK→ Confirm the Definition of Done (below) is met before declaring done
```

Steps **2, 4 (plan), and 10 (sync-check)** are the v2 additions — do not skip them.

---

## 📐 § Plan-First Protocol (timestamped plans for big requests)

**When the user makes a long or very extensive request, you MUST write a detailed,
timestamped plan to `PLANS/` and get it on disk BEFORE you build.**

### What counts as "long or very extensive"? (trigger if ANY apply)
- Touches **3+ scripts/modules**, or any **multi-system / cross-cutting** change.
- Introduces or removes a **mechanic, system, service, or DataStore schema**.
- A **refactor**, **migration**, **architecture change**, or anything that alters a
  **RemoteEvent/RemoteFunction contract**.
- The user uses words like *build / implement / overhaul / rework / redesign / add a
  system / from scratch / end-to-end*, or asks for several things at once.
- You estimate **more than ~30 minutes** of work or **more than a handful of files**.
- Anything with **breaking-change** potential (data keys, networking contracts, saves).

> Small, localized requests (one-line fix, single-file tweak, doc edit) do **not**
> need a `PLANS/` file — the inline PLAN step in the loop is enough. When unsure,
> write the plan; over-planning is cheap, silent scope-creep is not.

### How to plan
1. Create `PLANS/PLAN-[YYYYMMDD-HHMM]-[topic].md` from `PLANS/PLAN-TEMPLATE.md`.
2. Stamp it with the real UTC `[TIMESTAMP]`.
3. Fill in: the user's request verbatim, scope, **relational blast radius** (what
   systems/mechanics/story/UX/data this touches and what could break), an ordered
   step list, risks, rollback, and a verification checklist.
4. Link the plan from the active task in `_AGENT/TASKS.md` and from the session log.
5. Execute against the plan; **tick steps off and update the plan's `status`** as you
   go. If reality diverges, amend the plan (append a `## Revision [TIMESTAMP]` note —
   never silently rewrite history).
6. On completion, set the plan `status: completed` and link the resulting CHANGELOG
   entries / patch note.

---

## 🔒 § The Wiki Synchronization Contract ("Never Stale")

**The wiki must never lag behind the code.** This is the most important rule in the
vault. The wiki and the game's file system are two views of one truth; they may not
diverge across a completed unit of work.

### The contract
- **Every** create/modify/delete/move of a game or source file is paired, in the
  *same* unit of work, with: (1) a `CHANGELOG` entry, and (2) an update to every wiki
  page that describes the affected code/mechanic/contract.
- You may not end a turn/session having changed code without updating the wiki.
- If you discover the wiki is already wrong (drift from earlier work, or a Branch-B
  gap), **fixing it is part of the current task**, not a "later" item — repair it now
  and log a `DOCS` entry.
- The **code is authoritative.** When the wiki and code disagree, change the wiki to
  match the code (then, if the code is *wrong*, that's a separate FIX with its own plan).

### Startup Freshness Audit (run at the start of every session)
1. Compare modification times: any source file changed more recently than its wiki
   doc is a **staleness flag**.
   ```bash
   # quick heuristic: source files modified in the last N days
   find . -path ./_* -prune -o \( -name '*.lua' -o -name '*.luau' \) -mtime -7 -print
   ```
2. For each flagged file, re-read it and update its `CODE/scripts/*.md` (+ any mechanic
   / contract pages) to match. Log a `DOCS` entry per repair.
3. Verify the **RemoteEvent** and **DataStore** registries in
   `GAME/continuity/tracker.md` still match what's in the code.
4. If you find drift you can't immediately resolve, raise a continuity flag
   (`C-###`) and a task — never leave silent drift.

### ✅ Definition of Done (a task is NOT done until ALL are true)
- [ ] Code change complete and (where possible) verified to run.
- [ ] Every affected `CODE/scripts/*.md` / `CODE/architecture.md` updated.
- [ ] Every affected `GAME/mechanics/*.md`, `lore-bible.md`, `ux/flows.md` updated.
- [ ] `GAME/continuity/tracker.md` updated (RemoteEvent/DataStore/dependency changes).
- [ ] `_AGENT/CHANGELOG.md` has a timestamped entry for the change.
- [ ] `_AGENT/TASKS.md` updated (done items checked, new items added).
- [ ] If this was a big request: its `PLANS/` doc is updated to `completed`.
- [ ] A `SESSIONS/` log for this session exists/updated.
- [ ] All new pages cross-linked with `[[wikilinks]]`.
- [ ] No remaining staleness flags from the freshness audit (or each is ticketed).

---

## AGENT BEHAVIORAL RULES (active for all future sessions)

### ALWAYS
- Start every session by reading `_AGENT/CHANGELOG.md` (last 10), `_AGENT/TASKS.md`,
  scanning `BUGS/active/`, and running the **Startup Freshness Audit**.
- Before acting, **review wiki context, then verify it against the current code.**
- For long/extensive requests, **write a timestamped `PLANS/` doc before building.**
- End every session with a full session log in `SESSIONS/`.
- Cross-link ALL new pages with `[[wikilinks]]`; tag every file via YAML `tags:`.
- Document the **relational impact** of every change (what else it affects/breaks).
- Check `GAME/continuity/tracker.md` before touching multi-system code.
- Validate RemoteEvent/RemoteFunction contracts haven't changed unintentionally.
- Flag any story/lore continuity concerns in `GAME/continuity/tracker.md`.
- Satisfy the **Definition of Done** before declaring any task complete.

### NEVER
- Change code without logging to `_AGENT/CHANGELOG.md` and updating the wiki.
- Start a long/extensive build without a saved, timestamped plan.
- Leave the wiki describing something the code no longer does (no stale pages).
- Modify pre-existing source files during the initial bootstrap (additive only).
- Assume a mechanic or script works in isolation.
- Leave a bug report without a severity rating and an affected-system list.
- Overwrite story/lore content without flagging the continuity tracker.
- Skip the session log, or rename DataStore keys without a BREAKING CHANGE warning.
- Invent timestamps — obtain the real UTC time at runtime.

---

# 📁 PART 2 — VAULT FILE TEMPLATES

> Create each file below using the content provided. Frontmatter is required for
> Obsidian compatibility. `[PLACEHOLDER]` design text is left for the user to fill in.

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
You are a **Roblox Game Development Assistant** operating inside an Obsidian-compatible
wiki vault. You help develop, document, debug, and iterate on Roblox games using Luau —
and you keep this vault perfectly up to date as you do it. The vault may NEVER go stale.

## Core Responsibilities
| Responsibility | Description |
|---|---|
| Context Review   | Read the wiki, THEN verify against current code, before acting |
| Planning         | Write timestamped plans for long/extensive requests |
| Code Development | Write, refactor, and optimize Luau for Roblox Studio |
| Documentation    | Maintain this wiki in real time as changes are made |
| Research         | Fetch and log Roblox API / Luau / best-practice updates |
| Continuity       | Track mechanics, story, UX, contracts to prevent regression |
| Debugging        | Identify, log, and resolve bugs with root-cause analysis |
| Change Mgmt      | Log every meaningful change; keep wiki ≡ code (never stale) |

## Session Startup Checklist
- [ ] Read `_AGENT/CHANGELOG.md` (last 10 entries minimum)
- [ ] Read `_AGENT/TASKS.md` (active + backlog)
- [ ] Scan `BUGS/active/` for bugs relevant to the task
- [ ] Read `GAME/overview.md` to verify current game state
- [ ] Check `GAME/continuity/tracker.md` if touching multi-system code
- [ ] Run the **Startup Freshness Audit** (compare code mtimes vs wiki; repair drift)

## Before Every Request — Context-then-Code Review (MANDATORY)
1. **Review wiki context:** read the pages relevant to the request.
2. **Verify against reality:** open the ACTUAL code the request touches. The wiki is
   the map; the code is the territory. If they disagree, the code wins — update the
   wiki immediately and log a `DOCS` change.
3. **Decide plan depth:** if this is a long/extensive request (see vault `wiki.md` §
   Plan-First Protocol), create `PLANS/PLAN-[YYYYMMDD-HHMM]-[topic].md` and proceed
   only against it.

## Plan-First Trigger (write a timestamped PLANS/ doc when ANY apply)
- 3+ scripts touched, or any multi-system / cross-cutting change
- New/removed mechanic, system, service, or DataStore schema
- Refactor / migration / architecture change / RemoteEvent contract change
- User says build / implement / overhaul / rework / redesign / from scratch / end-to-end
- > ~30 min of work, several files, or any breaking-change potential

## Session End Checklist (Definition of Done)
- [ ] `_AGENT/CHANGELOG.md` updated (timestamped) for every change
- [ ] `_AGENT/TASKS.md` updated (done checked, new added)
- [ ] Every touched script documented in `CODE/scripts/` or `CODE/modules/`
- [ ] `CODE/architecture.md` updated if scripts/contracts changed
- [ ] New bugs logged in `BUGS/active/`; fixed bugs moved to `BUGS/resolved/`
- [ ] Session summary in `SESSIONS/[DATE]-[topic].md`
- [ ] `GAME/mechanics/index.md` updated if mechanics changed
- [ ] `GAME/story/lore-bible.md` updated if narrative changed
- [ ] `GAME/continuity/tracker.md` updated if cross-system changes made
- [ ] Any `PLANS/` doc for this work set to `completed`
- [ ] No unresolved staleness flags (wiki ≡ code)

## Code Standards
- Every script has a wiki entry in `CODE/scripts/` or `CODE/modules/`
- Strict server/client separation (see `CODE/architecture.md`)
- `ModuleScripts` for all shared logic
- `RemoteEvents` for server↔client; document the contract in the continuity tracker
- Prefer `task.spawn()/delay()/defer()` over legacy `coroutine`/`wait()`
- Type-annotate Luau functions where practical; `--!strict` on modules
- `pcall()` around all DataStore and HttpService calls
- Never trust client-sent data on the server — always validate

## Research Protocol
1. Search `_DOCS/` first. 2. If absent, fetch from https://create.roblox.com/docs.
3. Log to the right `_DOCS/` subfolder. 4. Cross-link from the relevant script/mechanic.
5. Log a `RESEARCH` entry in `_AGENT/CHANGELOG.md`.

## Required Documentation Fields (Per Script)
Purpose (1–2 sentences); script type (`Script`/`LocalScript`/`ModuleScript`); parent
location in the Roblox hierarchy; events fired/listened-to; dependencies; public API
(if ModuleScript); known bugs/quirks; last-modified timestamp + change summary.
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
Universal behavioral protocol for ANY AI agent operating in this Roblox Game
Development Wiki Vault — Claude, GPT, Gemini, or other. These rules apply without
exception.

## Vault Summary
A Roblox game-development wiki vault in Obsidian Markdown. It tracks code, mechanics,
story/lore, UX flows, bugs, patches, plans, and session history for one or more Roblox
games built in Roblox Studio with Luau. **The vault must always match the code.**

---

## The Documentation Loop (mandatory, every request)
```
0. ORIENT     Read CHANGELOG (last 10), TASKS, scan BUGS/active
1. CHECK      Read the relevant wiki pages (GAME/, CODE/, continuity)
2. VERIFY     Read the ACTUAL current code; reconcile drift (code wins → fix wiki)
3. RESEARCH   Fetch unknown APIs/patterns → log to _DOCS/
4. PLAN       List changes + blast radius. Big request → timestamped PLANS/ doc first
5. BUILD      Write or modify code / content / assets
6. DOCUMENT   Update script docs, mechanic pages, continuity tracker, architecture
7. LOG        Prepend a timestamped CHANGELOG entry
8. SESSION    Write SESSIONS/[DATE]-[topic].md
9. LINK       Cross-link all new pages with [[wikilinks]]
10. SYNC      Confirm the Definition of Done — wiki ≡ code — before declaring done
```

## Two non-negotiables
1. **Plan-First for big work.** Long/extensive requests get a detailed, timestamped
   plan saved to `PLANS/` *before* building. (Trigger list: 3+ files, new/removed
   system or DataStore schema, refactor/migration, contract change, breaking-change
   risk, or "build/implement/overhaul/rework/redesign/from-scratch/end-to-end".)
2. **Never Stale.** After ANY file-system change, log it and update every wiki page it
   affects, in the same unit of work. The code is authoritative; the wiki tracks it.

## Tagging Convention (frontmatter `tags:`)
| Tag | Usage | | Tag | Usage |
|---|---|---|---|---|
| agent | Agent config | | lore | Story / world-building |
| mechanic | Mechanic doc | | ux | UX / interface |
| script | Code / script doc | | session | Session log |
| bug | Bug report | | api | API / external docs |
| patch | Patch / fix record | | continuity | Continuity flag/tracker |
| plan | Timestamped plan | | deprecated | Deprecated code/mechanic |
| wip | Work in progress | | breaking | Breaking change warning |

## File Naming Convention
| Type | Pattern | Example |
|---|---|---|
| Plan | `PLAN-YYYYMMDD-HHMM-topic.md` | `PLAN-20260607-1432-combat-rework.md` |
| Session log | `YYYY-MM-DD-topic.md` | `2026-06-07-combat-rework.md` |
| Script/Module doc | `Name.md` (PascalCase) | `PlayerController.md` |
| Bug report | `BUG-###-short-desc.md` | `BUG-007-jump-exploit.md` |
| Patch note | `PATCH-vX.Y.Z-YYYY-MM-DD.md` | `PATCH-v1.2.0-2026-06-07.md` |
| Mechanic doc | `mechanic-name.md` (kebab) | `double-jump.md` |
| Story arc | `story-arc-name.md` | `chapter-1-the-fallen-tower.md` |

## Wikilink Convention
`[[overview]]`, `[[mechanics/double-jump]]`, `[[PlayerController]]`,
`[[BUG-007-jump-exploit]]`, `[[2026-06-07-combat-rework]]`,
`[[PLAN-20260607-1432-combat-rework]]`. Cross-linking is MANDATORY for: dependent
scripts, mechanics sharing state/events, story events triggered by mechanics, bugs
across systems, patches closing bugs, and plans driving sessions.

## Relational Documentation Standard
Every significant entry must answer:
► What does this do?  ► What does it depend on?  ► What depends on it?
► What breaks if it changes?  ► What story / UX elements does it affect?
This relational thinking is the core value of the vault.
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

> Single source of truth for all changes to code, mechanics, docs, plans, and systems.
> Agents MUST prepend an entry here after EVERY meaningful change (Never-Stale rule).
> Newest entries at the TOP. Use full UTC timestamps. Never delete rows.

## Change Type Reference
| Type | Meaning | | Type | Meaning |
|---|---|---|---|---|
| FEAT | New feature/mechanic/system | | LORE | Story / narrative change |
| FIX | Bug fix | | UX | UX / interface change |
| REFACTOR | Restructure, no behavior change | | DEPRECATE | Removed / replaced |
| DOCS | Documentation update only | | RESEARCH | New docs fetched + logged |
| PATCH | Balance / tuning / design | | PLAN | Plan created/updated |
| BREAKING | DataStore keys, API contracts, saves | | | |

---

## Log
| Timestamp (UTC) | Type | Scope | Description | Linked |
|---|---|---|---|---|
| [TIMESTAMP] | DOCS | Vault | Vault bootstrapped from wiki.md ([Branch A empty / Branch B seeded]) | [[wiki]] |

---
*Prepend new rows to the top. Never delete rows. Link plans, sessions, and files.*
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

> Agents update this at the start and end of every session.

## 🔴 Active — In Progress
| ID | Priority | Task | Session | Plan | Notes |
|---|---|---|---|---|---|
| T-001 | HIGH | Complete initial vault setup | Bootstrap | — | Auto-generated |

## 🟡 Backlog — Queued
| ID | Priority | Task | Source | Notes |
|---|---|---|---|---|
| T-002 | HIGH | Populate Roblox API docs from Creator Hub | Agent | See `_DOCS/` |
| T-003 | HIGH | Define game overview in `GAME/overview.md` | User | Ask user for concept |
| T-004 | MED | Research community libraries (Knit, etc.) | Agent | See `_DOCS/external/` |
| T-005 | MED | Set up / confirm code architecture | Agent | After overview defined |

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

> Created [TIMESTAMP]. Written BEFORE building because this is a long/extensive
> request. Execute against this plan; tick steps as you go; keep `status` current.

## 1. User Request (verbatim)
> [Paste exactly what the user asked for.]

## 2. Goal & Success Criteria
- [What "done" looks like, observably.]

## 3. Scope
**In scope:** [...]
**Out of scope:** [...]

## 4. Relational Blast Radius (what this touches / could break)
| System / Mechanic / Contract | How it's affected | Risk if wrong |
|---|---|---|
| `[[ScriptName]]` | [reads/writes/depends] | 🔴/🟠/🟡/🟢 |
| RemoteEvent `[Name]` | [contract change?] | |
| DataStore `[key]` | [schema change? BREAKING?] | |
| Story / UX | [[lore-bible]] / [[ux/flows]] | |

## 5. Step-by-Step Plan
- [ ] Step 1 — [action] (files: `...`)
- [ ] Step 2 — [action]
- [ ] Step 3 — [action]
- [ ] DOCUMENT — wiki pages to update: [...]
- [ ] LOG + SESSION + LINK — close out per Definition of Done

## 6. Risks & Mitigations
| Risk | Likelihood | Mitigation |
|---|---|---|

## 7. Rollback Plan
> If this breaks something, how do we revert? [steps]

## 8. Verification Checklist
- [ ] Runs in Studio without errors
- [ ] No RemoteEvent/DataStore contract broken (or migration in place)
- [ ] Continuity tracker updated; no new staleness flags
- [ ] CHANGELOG + session written

## 9. Revisions
> Append, never overwrite. `## Revision [TIMESTAMP] — [what changed & why]`
```

---

### 📄 FILE: GAME/overview.md

```
---
type: game-overview
game: [GAME NAME]
platform: Roblox
engine: Roblox Studio
language: Luau
genre: [GENRE]
game-type: [casual | story-driven | mechanic-heavy | hybrid]
status: in-development
roblox-place-id: [TBD]
version: 0.0.1
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [game, overview, roblox]
---

# 🎮 Game Overview: [GAME NAME]

## Elevator Pitch
> [2–3 sentences. What is it? Who is it for? What makes it fun?]

## Game Identity
| Property | Value |
|---|---|
| Genre | [Action RPG / Simulator / Obby / Battle Royale / Story Adventure] |
| Target Audience | [Ages 10–16 / Competitive / Casual] |
| Game Type | [ ] Casual  [ ] Story-Driven  [ ] Mechanic-Heavy  [ ] Hybrid |
| Multiplayer | [ ] Solo  [ ] Co-op  [ ] PvP  [ ] Mixed |
| Monetization | [ ] None  [ ] Gamepasses  [ ] Dev Products  [ ] Subscriptions |

## Core Game Loop
> Moment-to-moment experience. 3–5 steps.
1. [Step 1] 2. [Step 2] 3. [Step 3] 4. [repeat / escalate]

## Design Pillars
> 3–5 core values every design decision must serve.
1. **[Pillar 1]** — [Description]
2. **[Pillar 2]** — [Description]
3. **[Pillar 3]** — [Description]

---

## Key Systems Status
| System | Status | Wiki Link | Lead Script |
|---|---|---|---|
| Player Controller | 🔴 Not Started | [[mechanics/player-movement]] | `PlayerController` |
| Game State Manager | 🔴 Not Started | [[CODE/architecture]] | `GameStateManager` |
| Data Persistence | 🔴 Not Started | [[mechanics/data-persistence]] | `DataManager` |
| HUD / UI | 🔴 Not Started | [[ux/flows]] | `HUDController` |
| Audio System | 🔴 Not Started | — | `SoundManager` |

Legend: 🔴 Not Started · 🟡 In Progress · 🟢 Complete · 🔵 Live · ⚠️ Broken

---

## Story / Lore Summary
> Brief overview; full detail in [[story/lore-bible]].
[Summary, or "N/A — mechanics-only game"]

## UX Overview
> Top-level intentions; full detail in [[ux/flows]].
[Summary, or "N/A"]

---

## Related Pages
- [[mechanics/index]] · [[story/lore-bible]] · [[ux/flows]]
- [[CODE/architecture]] · [[continuity/tracker]] · [[_AGENT/CHANGELOG]]
```

---

### 📄 FILE: GAME/mechanics/index.md

```
---
type: mechanics-index
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [mechanics, index]
---

# ⚙️ Game Mechanics Index

> Master catalog of all game mechanics; each has its own page.
> Update this index whenever a mechanic is added, modified, or deprecated.

## How to Add a New Mechanic
1. Copy the template below to `GAME/mechanics/<mechanic-name>.md`
2. Fill in all sections — especially the relational fields
3. Add the mechanic to the registry table on this page
4. Link to relevant scripts in `CODE/scripts/` or `CODE/modules/`
5. Update `GAME/continuity/tracker.md` if it introduces dependencies
6. Log the addition in `_AGENT/CHANGELOG.md` as `FEAT`

## Mechanic Page Template (save as `GAME/mechanics/[name].md`)

    ---
    type: mechanic
    mechanic: [Name]
    category: movement | combat | progression | ui | world | social | economy | story
    status: planned | in-progress | implemented | patched | deprecated
    scripts: []
    created: [TIMESTAMP]
    updated: [TIMESTAMP]
    tags: [mechanic]
    ---
    # ⚙️ [Mechanic Name]
    ## Summary
    > What does it do? Why does it exist?
    ## Player Experience
    > What does the player see/feel/do when it's active?
    ## Technical Implementation
    ### Scripts Involved
    | Script | Role | Type | Location in Hierarchy |
    ### Events / Communication
    | Event Name | Direction | Fired When | Payload |
    ### State & Data
    > Variables, DataStore keys, shared state used.
    ## Dependencies
    | Dependency | Type | Why Required |
    ## Affects These Other Systems
    | System | How It's Affected |
    ## Story / UX Impact
    > Story triggers / UX-flow effects.
    ## Known Issues / Edge Cases
    | Issue | Severity | Bug Ticket | Notes |
    ## Change History
    | Timestamp | Change | Session |

---

## 🗂️ Mechanics Registry
### 🏃 Movement & Physics
| Mechanic | Status | Wiki Link | Scripts |
|---|---|---|---|
| [Basic Movement] | 🔴 Not Started | — | — |

### ⚔️ Combat & Interaction
*(none yet)*
### 📈 Progression & Economy
*(none yet)*
### 🌍 World & Environment
*(none yet)*
### 👥 Social & Multiplayer
*(none yet)*
### 💰 Monetization
*(none yet)*
### 📖 Story & Narrative Triggers
*(none yet)*
### 🖥️ UI & HUD Systems
*(none yet)*

---

## Mechanic Dependency Web
```
[Core Mechanic A]
    ↓ required by
[Mechanic B] ←→ [Mechanic C]
    ↓ triggers
[Story Event X]
```
```

---

### 📄 FILE: GAME/story/lore-bible.md

```
---
type: lore-bible
game: [GAME NAME]
canonical: true
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [lore, story, world-building, continuity]
---

# 📖 Lore Bible: [GAME NAME]

> CANONICAL source of truth for all story, world-building, and narrative.
> All agents MUST check here before changing story content. Conflicts →
> [[continuity/tracker]]. NEVER fabricate lore during bootstrap — leave placeholders.

## World Overview
### Setting
[Where/when does this take place?]
### Tone & Atmosphere
[Dark / Whimsical / Epic / Grounded / Horror / Hopeful…]
### Core Themes
1. [Theme 1] 2. [Theme 2] 3. [Theme 3]

## World Rules (Canon Laws)
> Non-negotiable truths. NEVER violate without user approval.
1. [Rule 1] 2. [Rule 2] 3. [Rule 3]

## Factions & Groups
| Name | Role | Alignment | Home Location | Notes |
|---|---|---|---|---|

## Key Characters & NPCs
| Name | Role | Faction | Mechanic Link | Notes |
|---|---|---|---|---|

## Story Structure
### Acts / Chapters
| # | Title | Summary | Status | Mechanic Trigger | Location |
|---|---|---|---|---|---|
| 1 | [Title] | [Summary] | 🔴 Not Written | [[mechanic-name]] | [Area] |

### Story-Mechanic Bridge Table
| Story Event | Trigger Condition | Script / Mechanic | Notes |
|---|---|---|---|

## Locations
| Location | Description | Faction | First Unlocked | Notes |
|---|---|---|---|---|

## Continuity Flags
> Open questions / potential contradictions. See [[continuity/tracker]].
- [ ] [Flag 1]
```

---

### 📄 FILE: GAME/ux/flows.md

```
---
type: ux-flows
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [ux, ui, design, flows]
---

# 🖥️ UX Flows & Interface Design

> All player-facing flows, screen states, UI elements, interaction decisions.
> Update whenever any UI component or player flow is added or changed.

## UX Principles for This Game
1. [Principle 1] 2. [Principle 2] 3. [Principle 3]

## Core Player Flows
### Game Entry
```
[Roblox loads] → [ReplicatedFirst runs] → [Loading screen]
    → [Character spawn] → [Tutorial check] → [Main loop]
```
### Main Menu
```
[ESC/Menu] → [Pause overlay] → Resume / Settings / Quit
```
### Death / Respawn
```
[Death] → [Animation] → [Respawn timer/prompt] → [Checkpoint] → [Resume]
```

## Screen Inventory
| Screen | Type | Trigger | Script | Status | Notes |
|---|---|---|---|---|---|
| Loading Screen | ScreenGui | Game load (ReplicatedFirst) | `LoadingScreen` | 🔴 | |
| Main HUD | ScreenGui | Player spawns | `HUDController` | 🔴 | |
| Pause Menu | ScreenGui | ESC | `PauseMenu` | 🔴 | |
| Settings Panel | ScreenGui | Settings button | `SettingsPanel` | 🔴 | |
| Death Screen | ScreenGui | Character died | `DeathScreen` | 🔴 | |

Status: 🔴 Not Built · 🟡 In Progress · 🟢 Done · ⚠️ Broken

## Main HUD Layout
| Element | Position | Purpose | Visible When | Script |
|---|---|---|---|---|
| [Health Bar] | [Top-left] | [Health] | [Always] | `HUDController` |

## Accessibility Checklist
- [ ] Text readable at ≥14pt equivalent
- [ ] Critical info not conveyed by color alone
- [ ] Gamepad support for all menus
- [ ] Mobile touch targets ≥ 44×44 px
- [ ] Screen-reader considerations for main HUD

## Related Pages
- [[overview]] · [[mechanics/index]] · [[CODE/architecture]]
```

---

### 📄 FILE: GAME/continuity/tracker.md

```
---
type: continuity-tracker
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [continuity, qa, dependencies]
---

# 🔗 Continuity Tracker

> Cross-system dependency map + consistency checker. Agents MUST check and update
> this whenever touching multi-system code, narrative, or DataStore schemas. This is
> also where wiki↔code drift gets flagged (the Never-Stale safety net).

## What Continuity Covers
| Type | Tracks |
|---|---|
| Mechanic | Does A still work after B changes? |
| Story | Narrative consistent across chapters/triggers? |
| UX | Experience consistent across screens/states? |
| Data | DataStore keys/schemas consistent across save/load? |
| Code | Dependent scripts still function after a refactor? |
| Event | RemoteEvent/BindableEvent contracts fulfilled? |

## Active Continuity Flags
| ID | Type | Description | Affects | Severity | Status |
|---|---|---|---|---|---|
| C-000 | Code | Initial vault setup — no flags yet | — | 🟢 OK | Open |

Severity: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low/OK

## System Dependency Map
```
[DataManager]
    ↓ feeds data to
[GameStateManager] ←→ [PlayerController]
    ↓                       ↓
[HUDController]      [CharacterAnimator]
    ↓
[UIEventBus]
```

## RemoteEvent / RemoteFunction Contract Registry
> If a contract changes, raise a continuity flag and a BREAKING changelog entry.
| Event Name | Direction | Fired By | Handled By | Payload Schema | Status |
|---|---|---|---|---|---|

## DataStore Key Registry
> NEVER rename a key without a migration strategy.
| Key Name | Store Name | Data Schema | Used By | Notes |
|---|---|---|---|---|

## Story-Mechanic Bridges
| Story Event | Trigger | Script / Mechanic | Chapter | Verified |
|---|---|---|---|---|

## Pre-Change Checklist (run before any major system change)
- [ ] All RemoteEvents have matching listeners on server AND client
- [ ] No DataStore key names changed (BREAKING if so)
- [ ] No circular `require()` dependencies introduced
- [ ] All UI screens still reachable via normal flow
- [ ] Story trigger flags still fire in correct order
- [ ] No new exploit vectors introduced
- [ ] Lore/narrative changes logged in [[story/lore-bible]]
- [ ] `_AGENT/CHANGELOG.md` updated with this change
- [ ] Wiki pages for touched code updated (no staleness)
```

---

### 📄 FILE: CODE/architecture.md

```
---
type: code-architecture
created: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [code, architecture, overview]
---

# 🏗️ Code Architecture Overview

> High-level map of all scripts, services, and modules. MUST be updated whenever
> scripts are added, removed, or restructured. In a seeded project, this is
> populated from the REAL source during STEP 1.5 ingestion.

## Roblox Hierarchy & Script Placement
```
DataModel (game)
├── Workspace                 ← Map geometry, parts, models, live objects
├── ReplicatedStorage         ← Shared (server + client)
│   ├── Modules/              ← Shared ModuleScripts (require())
│   └── RemoteEvents/         ← RemoteEvent / RemoteFunction objects
├── ReplicatedFirst           ← Runs on CLIENT before everything else
│   └── LoadingScreen/
├── ServerStorage             ← SERVER-ONLY storage (not replicated)
│   └── Assets/
├── ServerScriptService       ← SERVER-ONLY scripts
│   ├── GameLoop.server.lua
│   └── Services/             ← Server-side ModuleScripts / managers
├── StarterGui                ← UI cloned to each player's PlayerGui
│   ├── HUD/
│   └── Menus/
├── StarterPlayerScripts      ← LocalScripts cloned to player on join
│   └── PlayerController/
└── StarterCharacterScripts   ← Scripts cloned into character on spawn
    └── AnimationController/
```

## Architecture Principles
1. Server is authoritative — all game state on the server
2. Client predicts, server corrects
3. Validate ALL client input
4. ModuleScript-first for shared logic
5. Event-driven server↔client via RemoteEvents
6. Minimize replication
7. Fail gracefully — `pcall()` around DataStore/HTTP

## Data Flow Diagram
```
[Player Input (LocalScript)]
    ↓ RemoteEvent:FireServer(payload)
[Server Handler (Script)]  → validates payload
    ↓
[GameStateManager module] → [DataManager module] ──► DataStoreService
    ↓ FireClient(result)
[HUD / UI LocalScript — updates display]
```

## Script Inventory
| Script | Type | Location | Purpose | Status | Wiki Link |
|---|---|---|---|---|---|
| [GameLoop] | Script | ServerScriptService | Main server loop | 🔴 | — |

## Module Map
| Module | Location | Exported Functions | Used By |
|---|---|---|---|

## RemoteEvent Contract Registry
> Payload change = BREAKING. Mirror into [[continuity/tracker]].
| Event Name | Direction | Fired By | Received By | Payload | Purpose |
|---|---|---|---|---|---|

## Related Pages
- [[continuity/tracker]] · [[_DOCS/roblox-api/roblox-api-log]] · [[_DOCS/luau/luau-reference]]
```

---

### 📄 FILE: CODE/scripts/SCRIPT-TEMPLATE.md

```
---
type: script-doc
script-name: [ScriptName]
script-type: Script | LocalScript | ModuleScript
location: [e.g., ServerScriptService > Services]
runs-on: Server | Client | Both
status: planned | active | deprecated
created: [TIMESTAMP]
updated: [TIMESTAMP]
last-modified-session: [[SESSIONS/[DATE]-topic]]
tags: [script]
---

# 📜 [ScriptName]

## Purpose
> One or two sentences. What does this script do, and why does it exist?

## Script Identity
| Property | Value |
|---|---|
| Type | `Script` / `LocalScript` / `ModuleScript` |
| Parent Location | `[ServerScriptService > Services]` |
| Runs On | Server / Client / Both |
| Auto-runs | Yes / No (required by `[ModuleName]`) |

## Detailed Functionality
> What it does, how it works, key implementation decisions (with reasoning).

## Dependencies
| Dependency | Type | Why Needed |
|---|---|---|
| `[[ModuleName]]` | ModuleScript | [reason] |
| `RemoteEvents/EventName` | RemoteEvent | [reason] |
| `[Roblox Service]` | Service | [reason] |

## Events
### Fires
| Event | When | Payload Schema |
|---|---|---|
### Listens To
| Event | Source | What It Does |
|---|---|---|

## Public API (ModuleScripts only)
```lua
-- [FunctionName](param: type): returnType  -- description
```

## State & Data
| Variable / DataStore Key | Type | Scope | Description |
|---|---|---|---|

## Affects These Systems
| System / Script | How | Severity if Broken |
|---|---|---|
| `[[ScriptName]]` | reads/writes/depends | 🔴 Critical |

## Known Issues / Edge Cases
| Issue | Severity | Bug Ticket | Notes |
|---|---|---|---|

## Change History
| Timestamp | Type | Description | Session |
|---|---|---|---|
| [TIMESTAMP] | FEAT | Created | [[SESSIONS/[DATE]-topic]] |

> Copy to `CODE/scripts/[ActualName].md` per script. See [[CODE/architecture]].
```

---

### 📄 FILE: _DOCS/roblox-api/roblox-api-log.md

```
---
type: api-documentation
source: https://create.roblox.com/docs
fetched: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [api, roblox, documentation, research]
---

# 📚 Roblox API Documentation Log

> Auto-populated by agents during research. Append new entries; do not delete.
> Full reference: https://create.roblox.com/docs/reference/engine

## Architecture & Storage
### ReplicatedStorage
- **Purpose:** Shared container accessible by server and client
- **Use For:** ModuleScripts, RemoteEvents/Functions, shared assets
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/ReplicatedStorage
- **Notes:** [add findings]
### ServerScriptService
- **Purpose:** Server-side Scripts (not replicated)
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/ServerScriptService
- **Notes:**
### ServerStorage
- **Purpose:** Server-only storage, invisible to clients
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/ServerStorage
- **Notes:**

## Core Game Services
### RunService
- **Events:** `Heartbeat`, `Stepped` (before physics), `RenderStepped` (client-only)
- **Methods:** `IsServer()`, `IsClient()`, `IsStudio()`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/RunService
- **Notes:**
### Players
- **Events:** `PlayerAdded`, `PlayerRemoving`
- **Methods:** `GetPlayers()`, `GetPlayerFromCharacter()`, `GetUserIdFromNameAsync()`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/Players
- **Notes:**

## Persistence
### DataStoreService
- **Methods:** `GetDataStore(name)`, `GetOrderedDataStore(name)`, budget checks
- **DataStore:** `:GetAsync` `:SetAsync` `:UpdateAsync` `:RemoveAsync`
- **Important:** Always `pcall()`. ~6s throttle per key. Prefer `UpdateAsync`.
- **Docs:** https://create.roblox.com/docs/cloud-services/datastores
- **Notes:**
### MemoryStoreService
- **Purpose:** Fast temporary cross-server data (leaderboards, queues)
- **Docs:** https://create.roblox.com/docs/cloud-services/memory-stores
- **Notes:**

## Networking
### RemoteEvent
- **Methods:** `:FireServer` `:FireClient` `:FireAllClients`, `.OnServerEvent` `.OnClientEvent`
- **Best Practice:** Store in ReplicatedStorage; document every contract.
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/RemoteEvent
- **Notes:**
### RemoteFunction
- **Methods:** `:InvokeServer` `:InvokeClient`, `.OnServerInvoke` `.OnClientInvoke`
- **Caution:** Client can yield indefinitely; avoid invoking client in critical paths.
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/RemoteFunction
- **Notes:**

## UI & Input
### UserInputService
- **Events:** `InputBegan/Ended/Changed`; **Methods:** `IsKeyDown`, `GetMouseLocation`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/UserInputService
- **Notes:**
### TweenService
- **Method:** `Create(instance, TweenInfo.new(...), {goals}):Play()`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/TweenService
- **Notes:**

## External & Advanced
### HttpService
- **Methods:** `GetAsync`, `PostAsync`, `JSONEncode`, `JSONDecode`
- **Requirement:** Enable HTTP Requests in Game Settings.
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/HttpService
- **Notes:**
### MessagingService
- **Methods:** `PublishAsync(topic, msg)`, `SubscribeAsync(topic, cb)`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/MessagingService
- **Notes:**
### PathfindingService
- **Flow:** `CreatePath(params)` → `:ComputeAsync(start, goal)` → `:GetWaypoints()`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/PathfindingService
- **Notes:**
### CollectionService
- **Methods:** `AddTag` `RemoveTag` `GetTagged` `GetInstanceAddedSignal`
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/CollectionService
- **Notes:**
### MarketplaceService
- **Methods:** `PromptGamePassPurchase`, `UserOwnsGamePassAsync`, `PromptProductPurchase`, `ProcessReceipt`
- **Important:** `ProcessReceipt` MUST be idempotent.
- **Docs:** https://create.roblox.com/docs/reference/engine/classes/MarketplaceService
- **Notes:**

## Community Patterns & Libraries
### Knit — https://sleitnick.github.io/Knit/ — Services/Controllers/Components framework. **Notes:**
### ProfileService / ProfileStore — DataStore wrapper w/ session locking. **Notes:**
### Janitor / Maid — connection/instance cleanup; prevents leaks. **Notes:**

*Append new service entries as researched. Timestamp each entry.*
```

---

### 📄 FILE: _DOCS/luau/luau-reference.md

```
---
type: language-reference
language: Luau
source: https://luau.org
fetched: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [luau, language, reference, documentation]
---

# 📘 Luau Language Reference

> Fast, small, safe, gradually-typed language derived from Lua 5.1; Roblox-exclusive.
> Sources: https://luau.org and https://create.roblox.com/docs/scripting/luau

## Key Differences from Lua 5.1
| Feature | Lua 5.1 | Luau |
|---|---|---|
| Type annotations | ❌ | ✅ gradual/optional |
| String interpolation | ❌ | ✅ backtick literals |
| `continue` | ❌ | ✅ |
| Compound assignment | ❌ | ✅ `+= -= *= //=` |
| Generics | ❌ | ✅ |
| `buffer` library | ❌ | ✅ |
| `bit32` | external | ✅ built-in |
| `table.move` | ❌ | ✅ |

## Type Annotations
```lua
local name: string = "Roblox"
local health: number = 100
local maybeScore: number? = nil
local function takeDamage(amount: number, source: string?): boolean
    return health - amount > 0
end
type PlayerData = { UserId: number, DisplayName: string, Coins: number, Inventory: {string} }
type StringOrNumber = string | number
```

## String Interpolation
```lua
local who, lvl, score = "DevUser", 7, 42
local msg = `{who} reached level {lvl} with score {score}!`
local summary = `Health: {math.floor(health)}%`
```

## Task Library (prefer over legacy)
```lua
task.wait(1)
task.spawn(function() doSomething() end)
task.delay(2, function() doLater() end)
task.defer(function() doDeferred() end)
-- ❌ avoid: wait(1) / spawn(f) / delay(1,f)
```

## Common Roblox Patterns
### Module
```lua
local MathUtil = {}
function MathUtil.clamp(v: number, lo: number, hi: number): number
    return math.max(lo, math.min(hi, v))
end
return MathUtil
```
### RemoteEvent (validate on server!)
```lua
local RS = game:GetService("ReplicatedStorage")
local JumpEvent = RS.RemoteEvents.JumpRequest
JumpEvent.OnServerEvent:Connect(function(player: Player, data: {force: number})
    if typeof(data) ~= "table" or type(data.force) ~= "number" then return end
    if data.force > MAX_JUMP_FORCE then return end
    local char = player.Character
    local hum = char and char:FindFirstChildOfClass("Humanoid")
    if hum then hum.JumpPower = data.force; hum:ChangeState(Enum.HumanoidStateType.Jumping) end
end)
-- client: JumpEvent:FireServer({force = 50})
```
### DataStore (with pcall)
```lua
local DSS = game:GetService("DataStoreService")
local store = DSS:GetDataStore("PlayerData_v1")
local function save(userId: number, data): boolean
    local ok, err = pcall(function() store:SetAsync(tostring(userId), data) end)
    if not ok then warn(`save failed {userId}: {err}`) end
    return ok
end
```
### Connection cleanup (manual Janitor)
```lua
local conns: {RBXScriptConnection} = {}
local function cleanup()
    for _, c in conns do c:Disconnect() end
    table.clear(conns)
end
```

## Type-Checking Modes
```lua
--!strict     -- full checking, recommended for modules
--!nonstrict  -- relaxed (default)
--!nocheck    -- off
```

*Append new patterns and gotchas as discovered.*
```

---

### 📄 FILE: _DOCS/external/community-libraries.md

```
---
type: api-documentation
source: community
fetched: [TIMESTAMP]
updated: [TIMESTAMP]
tags: [api, external, libraries, research]
---

# 🧩 Community Libraries

> Third-party Roblox frameworks/utilities. In a seeded project, document the ones
> actually in use FIRST (detected during STEP 1.5 ingestion).

| Library | Purpose | In Use? | Version/Source | Notes |
|---|---|---|---|---|
| Knit | Service/Controller/Component framework — https://sleitnick.github.io/Knit/ | ? | | |
| ProfileService / ProfileStore | DataStore wrapper, session locking | ? | | |
| Roact / Fusion | Declarative UI | ? | | |
| Janitor / Maid | Cleanup / leak prevention | ? | | |
| Signal | Custom event implementation | ? | | |

*Add a detailed section per library actually adopted, with usage patterns + gotchas.*
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
affected-scripts: []
affected-mechanics: []
reported: [TIMESTAMP]
reported-session: [[SESSIONS/[DATE]-topic]]
updated: [TIMESTAMP]
tags: [bug]
---

# 🐛 BUG-[###]: [Short Title]

## Summary
**Expected:** [...]  **Actual:** [...]
**Frequency:** Always / Intermittent / Rare / Only when: [condition]
**Discovered in:** [[SESSIONS/[DATE]-topic]]

## Severity
🔴 Critical (game-breaking/data loss) · 🟠 High · 🟡 Medium (workaround) · 🟢 Low (cosmetic)
**This bug is:** [LEVEL]

## Steps to Reproduce
1. [...] 2. [...] 3. [observe]

## Affected Systems
| System | How Affected |
|---|---|
| `[[ScriptName]]` | [...] |

## Root Cause Analysis
[Diagnosis, or blank]

## Fix Plan
[Plan, or link to [[PLAN-...]] if non-trivial]

## Fix Applied (then move file to BUGS/resolved/)
```lua
-- what changed
```
**Resolved:** [TIMESTAMP] · **Session:** [[SESSIONS/[DATE]-topic]] · **Patch:** [[PATCHES/PATCH-vX.Y.Z-date]]

## Related
- [[related-bug]] · [[related-mechanic]]
```

---

### 📄 FILE: PATCHES/PATCH-TEMPLATE.md

```
---
type: patch-note
version: vX.Y.Z
date: [DATE]
created: [TIMESTAMP]
session: [[SESSIONS/[DATE]-topic]]
tags: [patch]
---

# 🔧 Patch vX.Y.Z — [DATE]

## Summary
> What this patch accomplishes and why.

## Changes
### ✅ Bug Fixes
| Bug | Description | Fix |
|---|---|---|
| [[BUG-###-desc]] | [...] | [...] |
### ⚙️ Mechanic / Balance
| Mechanic | Change | Reason |
|---|---|---|
### ✨ New Features
| Feature | Description | Wiki |
|---|---|---|
### 🗑️ Deprecated / Removed
| Item | Type | Replacement |
|---|---|---|
### 📚 Docs
| Page | What Changed |
|---|---|

## Files Modified
| File | Change Type | Description |
|---|---|---|

## Testing Checklist
- [ ] Core loop functional · [ ] No regression in affected mechanics
- [ ] Multiplayer tested · [ ] Mobile tested · [ ] DataStore save/load verified
- [ ] All fixed bugs verified

## Known Issues After This Patch
- [...]

## Rollback Plan
1. [...] 2. [...]
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

## Session Objective
1. [Goal 1] 2. [Goal 2]

## Work Completed
| Task | Outcome | Files Affected |
|---|---|---|
| [...] | ✅/⚠️/❌ | `[[ScriptName]]` |

## Code Changes
### ✨ Added
### 🔧 Modified
### 🗑️ Removed / Deprecated

## Research & Discoveries
> New APIs/patterns found; log substantial ones to `_DOCS/`.

## Bugs Encountered
| Bug ID | Description | Severity | Status | Link |
|---|---|---|---|---|

## Continuity Flags Raised
- [ ] [Flag] → [[continuity/tracker]]

## Wiki Sync Confirmation (Definition of Done)
- [ ] CHANGELOG updated  - [ ] Script/architecture docs updated
- [ ] Mechanic/lore/UX updated  - [ ] Continuity tracker updated
- [ ] Plan set to completed  - [ ] No staleness flags remain

## Changelog Entries (copied for reference)
| Timestamp | Type | Scope | Description |
|---|---|---|---|

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
  "attachmentFolderPath": "ASSETS",
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
    {"query": "tag:#mechanic",   "color": {"a": 1, "rgb": 3394764}},
    {"query": "tag:#lore",       "color": {"a": 1, "rgb": 10053222}},
    {"query": "tag:#script",     "color": {"a": 1, "rgb": 16744272}},
    {"query": "tag:#session",    "color": {"a": 1, "rgb": 6737151}},
    {"query": "tag:#ux",         "color": {"a": 1, "rgb": 16769792}},
    {"query": "tag:#api",        "color": {"a": 1, "rgb": 8388863}},
    {"query": "tag:#plan",       "color": {"a": 1, "rgb": 65407}},
    {"query": "tag:#continuity", "color": {"a": 1, "rgb": 16729156}}
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

> Condensed cheat sheet. Internalize this.

## The Documentation Loop (every request)
```
ORIENT → CHECK(wiki) → VERIFY(code) → RESEARCH → PLAN* → BUILD
       → DOCUMENT → LOG → SESSION → LINK → SYNC-CHECK
       (*timestamped PLANS/ doc for long/extensive requests)
```

## The Two v2 Imperatives
1. **Plan-First:** big request → write `PLANS/PLAN-[YYYYMMDD-HHMM]-topic.md` BEFORE building.
2. **Never Stale:** every code change → CHANGELOG entry + updated wiki, same unit of work.

## Definition of Done
Code done · all affected wiki pages updated · continuity tracker updated · CHANGELOG
entry · TASKS updated · PLAN completed · SESSION written · `[[wikilinks]]` added ·
no staleness flags.

## Startup Freshness Audit
Compare source mtimes vs their wiki docs → repair any code newer than its doc → verify
RemoteEvent/DataStore registries match code → ticket anything unresolved.

## Continuity Pre-Change Checklist
- [ ] RemoteEvent contracts unchanged (or BREAKING flagged)
- [ ] DataStore keys unchanged (or migration plan exists)
- [ ] No circular `require()` · [ ] All UI screens reachable
- [ ] Story triggers fire in order · [ ] Continuity tracker updated

## Vault Navigation Map
| I need to... | Go to... |
|---|---|
| Understand the game | [[GAME/overview]] |
| See all mechanics | [[GAME/mechanics/index]] |
| Read story/lore | [[GAME/story/lore-bible]] |
| Check UX flows | [[GAME/ux/flows]] |
| Cross-system deps | [[GAME/continuity/tracker]] |
| See all scripts | [[CODE/architecture]] |
| Active plans | `PLANS/` |
| Recent changes | [[_AGENT/CHANGELOG]] |
| Active tasks | [[_AGENT/TASKS]] |
| Active bugs | `BUGS/active/` |
| Past sessions | `SESSIONS/` |
| Roblox API ref | [[_DOCS/roblox-api/roblox-api-log]] |
| Luau patterns | [[_DOCS/luau/luau-reference]] |
| Community libs | [[_DOCS/external/community-libraries]] |

## Severity & Status Scales
Bugs/Continuity: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low/OK
System status: 🔴 Not started · 🟡 In progress · 🟢 Complete · 🔵 Live · ⚠️ Broken · 🗄️ Deprecated

---

*This vault was bootstrapped from wiki.md — Roblox Game Dev Wiki v2.0.0.*
*To re-run setup or update structure, edit wiki.md and re-execute PART 1.*
*Core laws: (1) review wiki then verify code before acting, (2) plan big work with
timestamps first, (3) never let the wiki go stale.*
