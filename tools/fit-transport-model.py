#!/usr/bin/env python3
"""Decide whether your I2P transport cost is FIXED or PER-BYTE, from your own measurements.

WHY THIS EXISTS
---------------
DESK-ANSWER-v98 left one question open, and it decided whether the DLEAG proof needed a wire change:

  v97's samples were 7853 / 1483 / 1490 / 1105 ms for 9147 bytes. Read as pure throughput that is
  1.14 KB/s and 95.5 KB costs ~84 s - hopeless. Read as fixed + rate it is ~18.5 s - inside the
  deadline. ONE PAYLOAD SIZE CANNOT TELL THOSE APART, and they call for opposite fixes.

The sweep of 2026-08-13 answered it: fixed cost dominates, the proof fits, and splitting would
MULTIPLY the dominant term. The tool stays because the next transport question will have the same
shape.

WHAT CHANGED IN v2, AND WHO CAUGHT IT
-------------------------------------
The client caught a real bug (CLIENT-ANSWER-v99 section 5). v1 selected "warm" samples by RANK -
`sorted(ms)[:-1]` drops the SLOWEST sample at every size, not the cold one. On a six-size sweep that
is six discards, all from the upper tail, biasing both terms toward the cheaper "it fits, no wire
change" answer. Measured on their data: rank-trim moved the fixed term 1496 -> 1240 ms and the rate
50.8 -> 88.3 KB/s, and the predicted proof time 3.42 -> 2.35 s. It did not change the verdict, but
that was the dataset being kind, not the method being safe.

v2 does not trim at all by default. The cold request is a real datapoint, and on a transport whose
whole problem is TAIL LATENCY, discarding the tail discards the subject.

AND ONE THE FIT CANNOT SEE
--------------------------
A least-squares line will happily fit data that contains no size effect at all. Two checks below
catch what r2 alone does not:

  MONOTONICITY   a size model REQUIRES median time to rise with size. In the 2026-08-13 sweep the
                 97786-byte median (1715 ms, n=25) came in BELOW both the 50000-byte median (3719)
                 and the 25000-byte one (1992). No per-byte model produces that, so the slope there
                 is fitting something other than size.

  DRIFT          if you sweep sizes in ascending order, size is confounded with ELAPSED TIME, and a
                 slow period during the sweep is booked as a per-byte cost. That is the same shape
                 as the v97 error one level up: two things moved together and the fit attributed
                 the effect to whichever one was on the x-axis. INTERLEAVE OR RANDOMISE SIZE ORDER.

HOW TO GATHER THE DATA
----------------------
`GET /api/desk/echo?bytes=N` (sigauth required, same as every other desk call). Returns EXACTLY N
bytes of incompressible filler, so a sweep measures the transport and not the desk. Defaults to
97786, the exact hex length of a real DLEAG proof. Max 262144. The response carries `X-Echo-Bytes`
so a clamp can never corrupt a measurement silently.

    for rep in 1 2 3 4 5; do                       # reps OUTSIDE, sizes INSIDE: one pass over all
      for n in 1000 5000 10000 25000 50000 97786;  # sizes per rep, so drift spreads across sizes
      do <your signed GET> /api/desk/echo?bytes=$n  # record milliseconds; DISCARD NOTHING
    done; done

Set the client timeout well ABOVE the deadline you are testing. The quantity under measurement is
time, and a client that gives up at the deadline turns every over-deadline sample into an error
instead of a datapoint - censoring the exact tail that decides the question. Apply the deadline in
analysis, never in the instrument. (The client did this; it is why the 15552 ms sample exists.)

USAGE
    ./fit-transport-model.py data.csv        # csv: bytes,milliseconds - IN MEASUREMENT ORDER
    ./fit-transport-model.py --demo          # v98's four samples: why one size cannot answer it

Plain ASCII throughout.
"""
from __future__ import annotations

import argparse
import statistics
import sys

REAL_PROOF_BYTES = 97786      # hex length of a DLEAG proof, as shipped today
GZIPPED_PROOF_BYTES = 56218   # gzip(hex) measured by the desk: 54.9 KB


def fit_linear(points):
    """Least-squares fit of ms = fixed + bytes*slope. Returns (fixed_ms, ms_per_byte, r2)."""
    n = len(points)
    if n < 2:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    fixed = my - slope * mx
    ss_res = sum((y - (fixed + slope * x)) ** 2 for x, y in zip(xs, ys))
    ss_tot = sum((y - my) ** 2 for y in ys)
    r2 = 1 - (ss_res / ss_tot) if ss_tot else 1.0
    return fixed, slope, r2


def describe(label, points):
    """One fit, one line. Returns (fixed_ms, ms_per_byte, r2) or None."""
    f = fit_linear(points)
    if not f:
        return None
    fixed, slope, r2 = f
    # BYTES PER MS *IS* KB/S (1 byte/ms = 1000 bytes/s = 1 KB/s). v1 divided by 1000 again and
    # reported 0.01 KB/s for a transport doing ~8 - a units error that made every reading look
    # catastrophic. The client confirmed the fix.
    rate = (1.0 / slope) if slope > 0 else float("inf")
    pred = (fixed + slope * REAL_PROOF_BYTES) / 1000
    print(f"  {label:<34} n={len(points):<3} fixed={fixed/1000:5.2f}s  rate={rate:8.2f} KB/s  "
          f"r2={r2:6.3f}  proof={pred:5.2f}s")
    return fixed, slope, r2


def main() -> int:
    ap = argparse.ArgumentParser(description="fixed-cost vs throughput, from your own numbers")
    ap.add_argument("csv", nargs="?", help="csv of bytes,milliseconds, in measurement order")
    ap.add_argument("--demo", action="store_true", help="run on v98's four samples")
    a = ap.parse_args()

    if a.demo:
        points = [(9147, 7853), (9147, 1483), (9147, 1490), (9147, 1105)]
        print("DEMO: v98's four samples, all at ONE size - which is the whole problem.\n")
    elif a.csv:
        points = []
        for ln, line in enumerate(open(a.csv), 1):
            line = line.strip()
            if not line or line.startswith("#") or line.lower().startswith("bytes"):
                continue
            try:
                b, ms = line.split(",")[:2]
                points.append((int(float(b)), float(ms)))
            except ValueError:
                print(f"  skipping line {ln}: {line!r}")
    else:
        ap.error("give a csv or --demo")

    sizes = sorted({p[0] for p in points})
    print(f"  {len(points)} samples across {len(sizes)} size(s): {sizes}\n")

    meds = []
    for s in sizes:
        ms = sorted(p[1] for p in points if p[0] == s)
        med = statistics.median(ms)
        meds.append((s, med))
        print(f"  {s:>7} bytes  n={len(ms):<3} min={min(ms):>8.0f}  median={med:>8.0f}"
              f"  max={max(ms):>8.0f} ms")

    if len(sizes) < 2:
        print("\n  ONE SIZE CANNOT DISTINGUISH THE MODELS. This is v98's problem exactly: the same")
        print("  numbers fit 'slow per byte' and 'fixed tunnel build' equally well, and those call")
        print("  for opposite fixes. Sweep at least 4 sizes - 1000 to 97786 - and re-run.")
        return 1

    # ------------------------------------------------------------------ the fit
    # NO TRIM. See the header: v1 trimmed by rank and lost the tail it was meant to measure.
    print("\n  FITS (the first is the answer; the rest show how much it depends on that choice)")
    head = describe("all samples, no trim", points)
    describe("minus the first request (cold)", points[1:])
    describe("per-size medians only", meds)
    slowest = max(p[1] for p in points)
    describe(f"minus the slowest ({slowest:.0f} ms)", [p for p in points if p[1] != slowest])
    fixed, slope, r2 = head

    # ------------------------------------------------- does a size model even hold
    print()
    # JITTER_RATIO gates the ADVICE, not the reporting. Every inversion is printed; only one deep
    # enough to be structural triggers "re-run interleaved". The client caught this: their
    # interleaved sweep trips a single 0.98x step - jitter by this tool's own sentence - and was
    # told to interleave, which is what it had just done. A check whose remedy it cannot clear
    # cannot tell you whether the remedy worked, and the discriminator was already in the output.
    JITTER_RATIO = 0.9
    inversions = [(a_, b_) for (a_, ma), (b_, mb) in zip(meds, meds[1:]) if mb < ma]
    if inversions:
        worst = 1.0
        print("  MONOTONICITY: FAILS. Median time does not rise with size at:")
        for a_, b_ in inversions:
            ma, mb = dict(meds)[a_], dict(meds)[b_]
            worst = min(worst, mb / ma)
            print(f"    {a_} bytes -> {ma:.0f} ms  BUT  {b_} bytes -> {mb:.0f} ms  "
                  f"({b_/a_:.1f}x the payload, {mb/ma:.2f}x the time)")
        if worst < JITTER_RATIO:
            print(f"  The deepest is {worst:.2f}x - too deep to be jitter. A per-byte model cannot")
            print("  produce that, so the slope below is fitting something other than size. Most")
            print("  likely DRIFT: if your sweep ran sizes in ascending order, size is confounded")
            print("  with elapsed time and a slow window is booked as a per-byte cost. Re-run with")
            print("  reps OUTSIDE and sizes INSIDE, alternating direction, then compare.")
            print("  This makes the case AGAINST splitting stronger, not weaker - the real per-byte")
            print("  cost is at most what is fitted here, and probably less.")
        else:
            print(f"  The deepest is {worst:.2f}x, within jitter (threshold {JITTER_RATIO:.2f}x). No")
            print("  structural inversion: this is noise around a real size effect, not a confound.")
    else:
        print("  MONOTONICITY: holds - median time rises with size at every step.")

    if r2 < 0.5:
        print(f"\n  r2 = {r2:.3f}. A linear size model explains {r2*100:.0f}% of this data. Do not")
        print("  carry the rate below forward as a property of the link; quote the measured times")
        print("  at the size you actually care about instead.")

    for label, size in (("real proof (hex)", REAL_PROOF_BYTES), ("gzipped", GZIPPED_PROOF_BYTES)):
        print(f"  PREDICTED {label:<18} {size:>7} bytes -> {(fixed + slope*size)/1000:6.1f} s")

    # ------------------------------------------------------- what the raw data says
    at_proof = [p[1] for p in points if p[0] == REAL_PROOF_BYTES]
    if at_proof:
        print(f"\n  MEASURED AT {REAL_PROOF_BYTES} BYTES (n={len(at_proof)}): "
              f"median {statistics.median(at_proof):.0f} ms, worst {max(at_proof):.0f} ms.")
        print("  Prefer this to any prediction. It is the size you ship.")

    # ----------------------------------------------------------------- the verdict
    # THE SPLIT TABLE PRINTS IN EVERY BRANCH, because splitting multiplies the fixed term whatever
    # its share is. On the client's interleaved data the share falls to 42% - "MIXED" - while 16
    # chunks would spend 29.0 s on setup ALONE, before a payload byte moves, against a 20 s
    # deadline. A verdict that only argued against splitting when fixed cost "dominates" would go
    # quiet exactly where the arithmetic is still decisive.
    print("\n  SPLITTING INTO N REQUESTS (N x fixed, payload unchanged):")
    for n in (1, 2, 4, 8, 16):
        t = n * fixed + slope * REAL_PROOF_BYTES
        print(f"    {n:>2} sequential -> {t/1000:6.1f} s   (setup alone: {n*fixed/1000:5.1f} s)")

    print()
    total = fixed + slope * REAL_PROOF_BYTES
    share = fixed / total if total else 0
    if share > 0.5:
        print(f"  VERDICT: FIXED COST DOMINATES ({share*100:.0f}% of the real-proof time is setup).")
        print("  Pre-warm the tunnel and gzip. DO NOT SPLIT - see the table above: N requests pay")
        print("  the fixed cost N times, so splitting manufactures the timeout it would prevent.")
    elif share < 0.2:
        print(f"  VERDICT: THROUGHPUT DOMINATES (setup is only {share*100:.0f}%).")
        print("  Gzip helps by its 43%, and if that still misses the deadline the proof has to be")
        print("  SPLIT - a two-sided wire change, agreed before either side ships it.")
    else:
        print(f"  VERDICT: MIXED ({share*100:.0f}% fixed). Gzip plus pre-warming may be enough; check")
        print("  the predictions above against your real deadline before committing to a wire change.")
    print("\n  Send the csv either way - the desk would rather re-derive it than take a verdict.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
