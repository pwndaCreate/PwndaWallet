/**
 * The sandbox mock must not be MORE forgiving than production — R3 edition.
 *
 * Adversarial-review finding F7 (HIGH): `sidecarStart()` in
 * `src/lib/tauri-mocks.ts` took **no arguments** and mirrored only
 * `swap_sidecar_start`'s opt-in guard. The Rust command had since grown a
 * second refusal — `check_first_prepare_gate` — which rejects a FIRST prepare
 * carrying no `particlMnemonic`, because a prepare on a fresh datadir with the
 * vault locked mints a Particl wallet nobody has a backup of (R3).
 *
 * With the mock more permissive than the backend, every sandbox / Playwright
 * pass over the setup wizard succeeded **unconditionally** while the real path
 * errored: a check that cannot fail for the reason it is run. That is worse
 * than no coverage, because it reads as coverage.
 *
 * These tests pin the two implementations together from both ends:
 *
 *   - **Behaviour**, through `getMock` — the same dispatcher the sandbox uses,
 *     so a regression in the arg wiring (the actual F7 defect) shows up here
 *     and not only in the private helper.
 *   - **Text**, by re-reading `swap_sidecar.rs` — so a change to the Rust
 *     refusal's wording, its condition, or its call-site arguments goes red
 *     here even though nothing in TypeScript moved.
 *
 * What this file deliberately does NOT do is import the mock's own refusal
 * constant and compare it with itself. The expected string is read out of the
 * Rust source; the actual string comes off a real rejection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root from THIS file's location, never a typed-in drive letter — see the
// note in src/wallets/derivation-paths.test.ts for why that matters.
// __tests__ → swap-sidecar → features → src → root.
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const RUST = read("src-tauri/src/swap_sidecar.rs");
const MOCK = read("src/lib/tauri-mocks.ts");

// ── The production gate, lifted out of the Rust source ────────────────────

/** Body of `check_first_prepare_gate`, from `{` to the fn's closing `}`. */
function rustGateBody(): string {
  const m = RUST.match(
    /pub fn check_first_prepare_gate\([\s\S]*?\)\s*->\s*Result<\(\), String>\s*\{([\s\S]*?)\n\}/,
  );
  if (!m) {
    throw new Error(
      "check_first_prepare_gate not found in src-tauri/src/swap_sidecar.rs — " +
        "the R3 gate was renamed or removed; re-mirror it in tauri-mocks.ts " +
        "before deleting this test",
    );
  }
  return m[1];
}

/** The `if` condition the backend refuses on, whitespace-normalized. */
function rustGateCondition(): string {
  const m = rustGateBody().match(/if\s+([^{]+?)\s*\{/);
  if (!m) throw new Error("no `if` condition inside check_first_prepare_gate");
  return m[1].replace(/\s+/g, " ").trim();
}

/** The refusal string the backend returns, verbatim. */
function rustRefusal(): string {
  const m = rustGateBody().match(/Err\("([^"]+)"\.to_string\(\)\)/);
  if (!m) throw new Error('no Err("…") inside check_first_prepare_gate');
  return m[1];
}

const snakeToCamel = (s: string) =>
  s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

// ── Loading the mock catalog under a chosen scenario ──────────────────────

type Mocks = typeof import("../../../lib/tauri-mocks");

/** Fresh module instance per test — `sidecarState` is a module singleton that
 *  the opt-in / start / stop mocks mutate, so tests must not share one. */
async function loadMocks(state: string): Promise<Mocks> {
  vi.resetModules();
  vi.stubEnv("VITE_MOCK_STATE", state);
  return (await import("../../../lib/tauri-mocks")) as Mocks;
}

/** A scenario whose sidecar starts un-opted-in with NO configured datadir —
 *  i.e. the first-run install, which is exactly what R3 guards. */
const FRESH = "wallet_populated";

/** Opt in the way the wizard does, leaving the datadir unconfigured. */
async function freshAndOptedIn(): Promise<Mocks> {
  const m = await loadMocks(FRESH);
  m.getMock("swap_sidecar_opt_in", { accepted: true });
  const status = m.getMock<{ configured: boolean; optedIn: boolean }>(
    "swap_sidecar_status",
  );
  // Preconditions, asserted rather than assumed: if `configured` were already
  // true the gate could never fire and every test below would pass vacuously.
  expect(status.optedIn, "precondition: opted in").toBe(true);
  expect(status.configured, "precondition: datadir NOT configured").toBe(false);
  return m;
}

/** BIP39 test vector — never a real phrase, and never logged. */
const TEST_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon art";

/** The mock steps preparing → starting → healthy over ~3.1 s on purpose. */
const START_MS = 3200;

interface StartOutcome {
  refused: boolean;
  /** The rejection's message; `""` when the start was allowed. */
  message: string;
  phase: string | null;
}

/**
 * Drive `swap_sidecar_start` and let its timer chain run out, so BOTH
 * outcomes settle inside the test.
 *
 * Written this way on purpose: a bare `await expect(p).rejects…` against a
 * mock that stopped refusing does not fail, it HANGS on a fake-timer promise
 * until vitest's 5 s timeout. That is red for "the promise never settled",
 * which reads as an environment fault — not as "the refusal is gone".
 */
async function start(m: Mocks, args?: unknown): Promise<StartOutcome> {
  const settled = m
    .getMock<Promise<{ phase: { phase: string } }>>("swap_sidecar_start", args)
    .then<StartOutcome, StartOutcome>(
      (status) => ({
        refused: false,
        message: "",
        phase: status?.phase?.phase ?? null,
      }),
      (e: unknown) => ({
        refused: true,
        message: e instanceof Error ? e.message : String(e),
        phase: null,
      }),
    );
  await vi.advanceTimersByTimeAsync(START_MS);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// =========================================================================

describe("F7 — swap_sidecar_start's mock takes ARGUMENTS", () => {
  it("gives different outcomes with and without particlMnemonic", async () => {
    // THE regression test. A mock whose `sidecarStart()` ignores its args
    // cannot tell these two calls apart, so one of them must come out wrong.
    const without = await start(await freshAndOptedIn(), {});
    const withPhrase = await start(await freshAndOptedIn(), {
      particlMnemonic: TEST_PHRASE,
    });

    expect(without.refused, "no phrase on a fresh datadir ⇒ refused").toBe(true);
    expect(withPhrase.refused, "phrase supplied ⇒ allowed").toBe(false);
  });
});

describe("R3 — a first prepare with no phrase is refused", () => {
  it("rejects with the BACKEND's refusal, verbatim", async () => {
    const r = await start(await freshAndOptedIn(), {});
    expect(r.refused).toBe(true);
    expect(r.message).toBe(rustRefusal());
  });

  it("rejects the same way when the arg object is omitted entirely", async () => {
    // `swapSidecarStart()` defaults to `{}`, but the dispatcher is also
    // reachable with no args at all — both must land on the same refusal
    // rather than one of them crashing on a property read of undefined.
    const r = await start(await freshAndOptedIn());
    expect(r.refused).toBe(true);
    expect(r.message).toBe(rustRefusal());
  });

  it("does NOT reach the preparing phase — the refusal precedes the work", async () => {
    const m = await freshAndOptedIn();
    const r = await start(m, {});
    expect(r.refused).toBe(true);
    const st = m.getMock<{ phase: unknown; configured: boolean }>(
      "swap_sidecar_status",
    );
    expect(st.phase, "a refused start must leave the node stopped").toEqual({
      phase: "stopped",
    });
    expect(st.configured, "and must not claim a datadir it never wrote").toBe(
      false,
    );
  });

  it("proceeds once the phrase is supplied, reaching healthy", async () => {
    const r = await start(await freshAndOptedIn(), {
      particlMnemonic: TEST_PHRASE,
    });
    expect(r.refused).toBe(false);
    expect(r.phase).toBe("healthy");
  });

  it('treats an EMPTY STRING as present, because Rust sees Some("")', async () => {
    // Not a nicety. Tauri hands an empty `particlMnemonic` to Rust as
    // `Some("")`, so `particl_mnemonic.is_some()` is true and the gate opens.
    // A mock that "helpfully" demanded a non-empty string would refuse where
    // production proceeds — the same class of defect as F7, sign flipped.
    const r = await start(await freshAndOptedIn(), { particlMnemonic: "" });
    expect(r.refused, "Option::is_some() is true for an empty string").toBe(
      false,
    );
  });
});

describe("R3's other half — the existing-config path is NOT gated", () => {
  // prepare.py:1436-1461 early-returns on an existing config without touching
  // a wallet, so a start (or a reconfigure) there cannot regenerate anything.
  // Gating it would break every already-installed user, and would break the
  // swap_sidecar_idle / swap_sidecar_active sandbox scenarios outright.

  it("swap_sidecar_idle starts with NO mnemonic and reaches healthy", async () => {
    const m = await loadMocks("swap_sidecar_idle");
    expect(
      m.getMock<{ configured: boolean }>("swap_sidecar_status").configured,
      "precondition: this scenario has a configured datadir",
    ).toBe(true);
    const r = await start(m, {});
    expect(r.refused).toBe(false);
    expect(r.phase).toBe("healthy");
  });

  it("a reconfigure of a configured install is not a first prepare", async () => {
    // `run_prepare` is TRUE here (the reconfigure flag), and the gate still
    // must not fire because `config_exists` is true. This is the row that
    // separates "refuse a FIRST prepare" from "refuse every prepare".
    const r = await start(await loadMocks("swap_sidecar_idle"), {
      reconfigure: true,
    });
    expect(r.refused).toBe(false);
    expect(r.phase).toBe("healthy");
  });

  it("swap_sidecar_active short-circuits on a running node, no gate", async () => {
    const r = await start(await loadMocks("swap_sidecar_active"), {});
    expect(r.refused).toBe(false);
    expect(r.phase).toBe("healthy");
  });
});

describe("guard ORDER matches swap_sidecar_start", () => {
  it("an un-opted-in start still fails on OPT-IN, not on R3", async () => {
    // Rust checks opt-in first and returns before the datadir is even read.
    // If R3 were checked first, the error every not-yet-consented user sees
    // would change from "accept the setup screen" to "unlock the vault".
    const r = await start(await loadMocks(FRESH), {});
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/has not been enabled/);
    expect(r.message).not.toBe(rustRefusal());
  });

  it("a start while the node is coming up returns status, not a refusal", async () => {
    // `Phase::is_running()` is Starting | Healthy | Stopping — the early
    // return that runs BEFORE the gate. The mock used to test `healthy`
    // alone, so a second start mid-bring-up re-entered `preparing`, which is
    // a transition `Phase::can_transition` rejects.
    const m = await freshAndOptedIn();
    const first = m.getMock<Promise<{ phase: { phase: string } }>>(
      "swap_sidecar_start",
      { particlMnemonic: TEST_PHRASE },
    );
    await vi.advanceTimersByTimeAsync(1000); // past preparing, into starting
    expect(m.getMock<{ phase: unknown }>("swap_sidecar_status").phase).toEqual({
      phase: "starting",
    });

    const second = m.getMock<Promise<unknown>>("swap_sidecar_start", {});
    void second.catch(() => {
      /* a mutated mock may reject here; the phase assertion below is the point */
    });
    expect(
      m.getMock<{ phase: unknown }>("swap_sidecar_status").phase,
      "a second start must not knock the node back to `preparing`",
    ).toEqual({ phase: "starting" });

    await vi.advanceTimersByTimeAsync(START_MS);
    await expect(first).resolves.toMatchObject({ phase: { phase: "healthy" } });
  });
});

describe("text parity with src-tauri/src/swap_sidecar.rs", () => {
  it("the mock's refusal string IS the Rust literal", async () => {
    const r = await start(await freshAndOptedIn(), {});
    expect(
      r.message,
      "the sandbox must show the user the backend's own wording",
    ).toBe(rustRefusal());
  });

  it("the Rust condition still has the shape the mock mirrors", () => {
    // Drift alarm. If the backend widens the gate (say, gating a reconfigure
    // too) this goes red even though nothing in TypeScript moved — which is
    // the only way the mock's owner finds out.
    const cond = rustGateCondition();
    expect(cond).toBe("run_prepare && !has_mnemonic && !config_exists");

    const mirrored = snakeToCamel(cond);
    expect(
      MOCK.replace(/\s+/g, " "),
      `tauri-mocks.ts must refuse on \`${mirrored}\``,
    ).toContain(
      `if (${mirrored}) { return Promise.reject(new Error(SIDECAR_FIRST_PREPARE_REFUSAL)); }`,
    );
  });

  it("the call site still feeds the gate the three inputs the mock models", () => {
    // `has_mnemonic` is `is_some()` (hence the empty-string test above) and
    // `config_exists` is "a basicswap.json exists" (hence `st.configured`).
    // If either argument were re-sourced, the mock would be modelling the
    // wrong quantity while still looking correct.
    //
    // `[^{};]*` cannot span a function body, so this skips the DEFINITION
    // (whose signature is followed by `{`) and lands on the call site. A lazy
    // `[\s\S]*?` here matched from `pub fn` all the way to the call's `)?;`
    // and reported the gate's own PARAMETER LIST as its arguments — a green
    // test asserting the wrong text.
    const call = RUST.match(/check_first_prepare_gate\(([^{};]*)\)\?;/);
    expect(
      call,
      "no `check_first_prepare_gate(...)?;` call site",
    ).not.toBeNull();
    expect(call![1].replace(/\s+/g, " ").trim()).toBe(
      "run_prepare, particl_mnemonic.is_some(), configured.is_some()",
    );
  });

  it("run_prepare is still derived from `configured` the way the mock derives it", () => {
    // The mock has no credsfile and no port planner, so it computes
    // `runPrepare = !configExists || reconfigure`. That is only sound while
    // `plan_session_ports` sets `run_prepare` from `configured.is_none()`,
    // and while `swap_sidecar_start` ORs the reconfigure flag into it.
    //
    // swap_sidecar.rs is CRLF on disk, so `\n\}\n` never matches `}\r\n`.
    const planner = RUST.match(
      /pub fn plan_session_ports\([\s\S]*?\r?\n\}\r?\n/,
    );
    expect(planner, "plan_session_ports not found").not.toBeNull();
    const body = planner![0].replace(/\s+/g, " ");
    expect(body).toContain("Some((html, ws)) => { let port_offset");
    expect(body).toContain("run_prepare: false");
    expect(body).toContain("None => {");
    expect(body).toContain("run_prepare: true");
    expect(
      RUST.replace(/\s+/g, " "),
      "swap_sidecar_start must still OR the reconfigure flag into run_prepare",
    ).toContain(
      "let run_prepare = ports.run_prepare || reconfigure.unwrap_or(false) || !creds_present;",
    );
  });
});
