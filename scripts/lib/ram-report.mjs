// scripts/lib/ram-report.mjs
//
// RAM plan Phase 4 ("confirm and write it down"), as a reader instead of a
// by-hand session: turns one `mem-native-*.jsonl` session (written by
// src-tauri/src/mem_watch.rs, dev builds only) into the §Targets table of
// PwndaWalletVault/wiki/synthesis/ram-optimization-execution-plan.md.
//
// Pure functions only; `scripts/ram-report.mjs` is the CLI. Pinned by
// `ramReport.test.mjs`.
//
// What a sample can and cannot say (read before trusting a verdict):
// - Configuration is inferred from which roles are present, not recorded. A
//   sample with no wallet sidecar and no swap node is "no sidecars": locked,
//   OR unlocked with every chain wallet asleep (RAM plan 3.1). The swap node
//   never starts before unlock.
// - Committed memory (`treeCommitMb`, `commitByRole`) exists only in samples
//   written since RAM plan 3.4 (2026-09-25). Earlier sessions are judged on
//   working set, which Windows trims, so it under-reads.
// - Committed memory is recorded per ROLE, not per process. The swap-node
//   role is `particld` plus BasicSwap's python, so "committed, excluding
//   particld" is estimated as (commit excl. miners) - (swap-node commit) +
//   (python's working set). Python commits about what it keeps resident
//   (57 MB WS / 50 MB committed, measured 2026-09-26), so the estimate is
//   good to a few tens of MB. Working set excluding particld is exact.

/** Restated 2026-09-26 by the operator: the swap-node target excludes `particld`. */
export const TARGETS = {
  none: { limitMb: 600, label: "Wallet, no chain sidecars (locked, or all asleep)" },
  wallet: { limitMb: 600, label: "Wallet, chain sidecars awake, no swap node" },
  swap: { limitMb: 1300, label: "Wallet + light swap node, excluding particld", excludeParticld: true },
};
/** The wallet's own overhead while mining, over the same configuration idle. */
export const MINING_DELTA_LIMIT_MB = 100;
/** A gap longer than this between samples is the app being closed, not a sample. */
export const MAX_SAMPLE_GAP_MS = 5 * 60_000;
/**
 * Fewer samples than this (10 minutes at the 60 s cadence) is a transition
 * — e.g. the minute between unlock and the swap node starting — not a
 * configuration anyone ran. Shown, never judged.
 */
export const MIN_SAMPLES_TO_JUDGE = 10;

const ROLE_KEYS = ["webviewMb", "walletRpcMb", "swapNodeMb", "otherMb", "minersMb"];

const nameMb = (s, name) =>
  (s.byName ?? []).filter((x) => x.name.toLowerCase() === name).reduce((a, x) => a + x.mb, 0);

/** Configuration of one sample, or null for a sample written before per-role data. */
export function configOf(s) {
  const r = s.byRole;
  if (!r) return null;
  const base = (r.swapNodeMb ?? 0) > 1 ? "swap" : (r.walletRpcMb ?? 0) > 1 ? "wallet" : "none";
  return { base, mining: (r.minersMb ?? 0) > 1 };
}

/** The per-sample figures every verdict is built from. Miners are always excluded. */
export function metricsOf(s) {
  const miners = s.byRole?.minersMb ?? 0;
  const particld = nameMb(s, "particld.exe");
  const python = nameMb(s, "python.exe");
  const ws = s.treeMb - miners;
  const m = {
    ws,
    wsExParticld: ws - particld,
    // WebView2's working set is trimmed on blur (mem_pressure's Low level), so
    // it swings by a GB with focus, not with memory use. Where no committed
    // figure exists, compare configurations on everything else.
    wsExWebview: ws - (s.byRole?.webviewMb ?? 0),
    particldWs: particld,
    commit: null,
    commitExParticld: null,
  };
  if (s.commitByRole && typeof s.treeCommitMb === "number") {
    m.commit = s.treeCommitMb - (s.commitByRole.minersMb ?? 0);
    m.commitExParticld = m.commit - (s.commitByRole.swapNodeMb ?? 0) + python;
  }
  return m;
}

export function quantile(values, q) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

const spread = (values) => ({ median: quantile(values, 0.5), p10: quantile(values, 0.1), p90: quantile(values, 0.9) });

/** Hours actually covered: the sum of sample intervals, not counting gaps. */
export function coveredHours(samples) {
  let ms = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].t - samples[i - 1].t;
    if (d > 0 && d <= MAX_SAMPLE_GAP_MS) ms += d;
  }
  return ms / 3_600_000;
}

/** Least-squares slope of y over time, in MB per hour. Null below 2 points or 10 minutes. */
export function slopePerHour(points) {
  const p = points.filter((x) => typeof x.y === "number");
  if (p.length < 2 || p[p.length - 1].t - p[0].t < 10 * 60_000) return null;
  const xs = p.map((x) => (x.t - p[0].t) / 3_600_000);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = p.reduce((a, b) => a + b.y, 0) / p.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < p.length; i++) {
    num += (xs[i] - mx) * (p[i].y - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : null;
}

/** Everything the report prints, from one session's samples (in time order). */
export function summarize(samples) {
  const usable = samples.filter((s) => configOf(s));
  const groups = new Map();
  for (const s of usable) {
    const c = configOf(s);
    const key = `${c.base}${c.mining ? "+mining" : ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const buckets = {};
  for (const [key, ss] of groups) {
    const ms = ss.map(metricsOf);
    const hasCommit = ms.some((m) => m.commit !== null);
    const roles = {};
    for (const k of ROLE_KEYS) {
      roles[k] = {
        ws: quantile(ss.map((s) => s.byRole[k] ?? 0), 0.5),
        commit: hasCommit ? quantile(ss.filter((s) => s.commitByRole).map((s) => s.commitByRole[k] ?? 0), 0.5) : null,
      };
    }
    buckets[key] = {
      n: ss.length,
      hours: coveredHours(ss),
      ws: spread(ms.map((m) => m.ws)),
      wsExParticld: spread(ms.map((m) => m.wsExParticld)),
      wsExWebview: spread(ms.map((m) => m.wsExWebview)),
      commit: hasCommit ? spread(ms.map((m) => m.commit)) : null,
      commitExParticld: hasCommit ? spread(ms.map((m) => m.commitExParticld)) : null,
      particldWs: quantile(ms.map((m) => m.particldWs), 0.5),
      roles,
    };
  }
  const rendererPoints = usable.map((s) => ({ t: s.t, y: s.rendererCommitMb }));
  const withRenderer = rendererPoints.filter((p) => typeof p.y === "number");
  return {
    samples: samples.length,
    usable: usable.length,
    from: samples.length ? samples[0].t : null,
    to: samples.length ? samples[samples.length - 1].t : null,
    hours: coveredHours(samples),
    buckets,
    renderer: withRenderer.length
      ? {
          first: withRenderer[0].y,
          last: withRenderer[withRenderer.length - 1].y,
          max: Math.max(...withRenderer.map((p) => p.y)),
          slopeMbPerHour: slopePerHour(withRenderer),
          // The first hour is the UI loading after unlock (20 → ~200 MB in 28
          // min, 2026-09-26); a leak rate is what comes after it.
          slopeAfterFirstHourMbPerHour: slopePerHour(withRenderer.filter((p) => p.t - withRenderer[0].t >= 3_600_000)),
        }
      : null,
    watch: {
      powershellWsMax: Math.max(0, ...samples.map((s) => nameMb(s, "powershell.exe"))),
      emitPerMinMax: Math.max(0, ...samples.map((s) => s.emitPerMin ?? 0)),
    },
  };
}

/**
 * One verdict per configuration present. Judged on committed memory where the
 * session has it (working set is trimmed and under-reads), else on working
 * set, and says which. `pass: null` = shown but not judged, with `why`.
 */
export function verdicts(summary) {
  const out = [];
  const tooFew = (n) => n < MIN_SAMPLES_TO_JUDGE;
  for (const base of ["none", "wallet", "swap"]) {
    const b = summary.buckets[base];
    const mined = summary.buckets[`${base}+mining`];
    if (b) {
      const t = TARGETS[base];
      const commitSpread = t.excludeParticld ? b.commitExParticld : b.commit;
      const judged = commitSpread ?? (t.excludeParticld ? b.wsExParticld : b.ws);
      out.push({
        config: base,
        label: t.label,
        limitMb: t.limitMb,
        metric: commitSpread ? "committed" : "working set",
        medianMb: judged.median,
        pass: tooFew(b.n) ? null : judged.median <= t.limitMb,
        why: tooFew(b.n) ? `${b.n} sample(s): a transition, not a configuration` : null,
        n: b.n,
        hours: b.hours,
      });
    }
    if (!mined) continue;
    const label = `${TARGETS[base].label} — mining overhead over idle (miners excluded)`;
    if (!b || tooFew(b.n) || tooFew(mined.n)) {
      out.push({
        config: `${base}+mining`,
        label,
        limitMb: MINING_DELTA_LIMIT_MB,
        metric: "—",
        medianMb: null,
        pass: null,
        why: !b ? "no idle stretch of the same configuration to compare with" : "too few samples on one side",
        n: mined.n,
        hours: mined.hours,
      });
      continue;
    }
    // One measure on both sides, or the delta compares unlike things. Without
    // committed data, WebView2 is left out: its working set follows focus.
    const useCommit = Boolean(b.commit && mined.commit);
    const delta = useCommit
      ? mined.commit.median - b.commit.median
      : mined.wsExWebview.median - b.wsExWebview.median;
    out.push({
      config: `${base}+mining`,
      label,
      limitMb: MINING_DELTA_LIMIT_MB,
      metric: useCommit ? "committed" : "working set, WebView2 excluded",
      medianMb: delta,
      pass: delta <= MINING_DELTA_LIMIT_MB,
      why: null,
      n: mined.n,
      hours: mined.hours,
    });
  }
  return out;
}

const mb = (x) => (x === null || x === undefined ? "—" : `${Math.round(x).toLocaleString("en-US")}`);
const sp = (s) => (s ? `${mb(s.median)} (${mb(s.p10)}–${mb(s.p90)})` : "—");

/** Markdown, ready to paste into the plan. */
export function toMarkdown(name, summary) {
  const iso = (t) => (t ? new Date(t).toISOString().replace(".000Z", "Z") : "—");
  const lines = [];
  lines.push(`### \`${name}\``);
  lines.push("");
  lines.push(
    `${summary.samples} samples, ${summary.usable} with per-role data, ${summary.hours.toFixed(1)} h covered (${iso(summary.from)} → ${iso(summary.to)}).`,
  );
  lines.push("");
  lines.push("| Configuration | Samples (h) | Committed, excl. miners — median (p10–p90) | Working set, excl. miners | excl. particld: committed ≈ / WS | particld WS |");
  lines.push("|---|---|---|---|---|---|");
  for (const [key, b] of Object.entries(summary.buckets)) {
    lines.push(
      `| ${key} | ${b.n} (${b.hours.toFixed(1)}) | ${sp(b.commit)} | ${sp(b.ws)} | ${mb(b.commitExParticld?.median)} / ${mb(b.wsExParticld.median)} | ${mb(b.particldWs)} |`,
    );
  }
  lines.push("");
  lines.push("| Verdict | Target | Judged on | Median | Result |");
  lines.push("|---|---|---|---|---|");
  for (const v of verdicts(summary)) {
    const result = v.pass === null ? `not judged — ${v.why}` : v.pass ? "✅" : "❌";
    lines.push(`| ${v.label} | ≤ ${v.config.endsWith("+mining") ? "+" : ""}${mb(v.limitMb)} MB | ${v.metric} | ${v.medianMb === null ? "—" : mb(v.medianMb)} | ${result} |`);
  }
  lines.push("");
  lines.push("| Role medians (WS / committed) | " + ROLE_KEYS.map((k) => k.replace(/Mb$/, "")).join(" | ") + " |");
  lines.push("|---|" + ROLE_KEYS.map(() => "---").join("|") + "|");
  for (const [key, b] of Object.entries(summary.buckets)) {
    lines.push(`| ${key} | ` + ROLE_KEYS.map((k) => `${mb(b.roles[k].ws)} / ${mb(b.roles[k].commit)}`).join(" | ") + " |");
  }
  lines.push("");
  if (summary.renderer) {
    const r = summary.renderer;
    lines.push(
      `Renderer commit: ${mb(r.first)} → ${mb(r.last)} MB (max ${mb(r.max)}); slope ${r.slopeMbPerHour === null ? "—" : `${r.slopeMbPerHour.toFixed(1)} MB/h`} overall, ${r.slopeAfterFirstHourMbPerHour === null ? "— (under an hour of data past the first)" : `${r.slopeAfterFirstHourMbPerHour.toFixed(1)} MB/h`} after the first hour. The \`mem_guard\` breaker fires at 3,072 MB.`,
    );
  } else {
    lines.push("Renderer commit: not recorded (session predates RAM plan 3.4).");
  }
  lines.push(
    `Regression watch: powershell.exe WS max ${mb(summary.watch.powershellWsMax)} MB (was 618 before the 2026-09-25 fix); emitPerMin max ${summary.watch.emitPerMinMax} (budget 60).`,
  );
  return lines.join("\n");
}

/** Parse a JSONL session, skipping blank or torn lines (the live file may end mid-write). */
export function parseSession(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (typeof s.t === "number" && typeof s.treeMb === "number") out.push(s);
    } catch {
      /* a torn last line of a live session */
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
