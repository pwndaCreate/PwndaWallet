/**
 * Canonical user-facing strings for PwndaWallet.
 *
 * Centralized per ease-of-use-improvement-plan T3.5 so a single edit
 * propagates across portrait and landscape, and so the T3.3 ALL-CAPS
 * softening can be audited from one file.
 *
 * Casing contract (T3.3):
 *   - eyebrows / section headings / BottomNav / hero captions / wordmark
 *     stay ALL-CAPS at the call site (still applied via
 *     `text-transform: uppercase`).
 *   - field labels INSIDE cards live here in Title Case ("Pool",
 *     "Worker", "Per hour").
 *   - long-form copy lives here in sentence case ("Routing through
 *     NEAR Intents…", "12-word seed phrase is just entropy…").
 *
 * Why a single file: one grep finds every string the user reads;
 * future translation / a/b copy testing has a single seam.
 */

export const COPY = {
  mining: {
    // SESSION card field labels (was: ACCEPTED / REJECTED / SHARES/MIN /
    // POOL LATENCY / POOL DIFF / EST. EARNINGS). Each pair has a label
    // and the tooltip (kept sentence-case throughout).
    session: {
      acceptedLabel: "Accepted shares",
      acceptedTooltip:
        "Shares the pool credited to you. Higher is better; this number should keep growing.",
      rejectedLabel: "Rejected shares",
      rejectedTooltip:
        "Shares the pool refused (usually stale — submitted just after the round ended). Lower is better; a few per session is normal.",
      sharesPerMinLabel: "Shares per minute",
      sharesPerMinTooltip:
        "How fast you're submitting valid work. Higher is better; depends on your hashrate and the pool's difficulty.",
      estEarningsLabel: "Est. earnings",
      estEarningsTooltip:
        "Estimated payout if you keep mining at the current rate for a full day. Updates as price and hashrate move.",
      poolLatencyLabel: "Pool latency",
      poolLatencyTooltip:
        "Round-trip time to the pool's stratum server. Lower is better; under 100ms is healthy.",
      poolDifficultyLabel: "Pool difficulty",
      poolDifficultyTooltip:
        "The pool's current target difficulty for your worker. Higher means each share you submit represents more work.",
    },
    // Coin grid sub-caption format (was: "RANDOMX · CPU"). Returns the
    // full "<Coin> / <Algorithm> (<Hardware>)" form per T3.5.
    coinAlgoSubtitle(chain: string): string {
      switch (chain) {
        case "monero":
          return "Monero / RandomX (CPU)";
        case "zephyr":
          return "Zephyr / RandomX (CPU)";
        case "ravencoin":
          return "Ravencoin / KawPow (GPU)";
        case "ergo":
          return "Ergo / Autolykos2 (GPU)";
        case "conflux":
        default:
          return "Conflux / Octopus (GPU)";
      }
    },
  },
  swap: {
    rateCard: {
      rateLabel: "Rate",
      minReceivedLabel: "Minimum received",
      feeLabel: "Fee",
      providerLabel: "Provider",
      etaPrefix: "Settles in",
      placeholder:
        "Enter an amount to see the quote, fee, and minimum received.",
    },
    nearIntentsDisclaimer:
      "Routing through NEAR Intents (cross-chain bridge). Quotes are live; nothing moves until you confirm a swap.",
  },
  activity: {
    rowSent: "Sent",
    rowReceived: "Received",
    emptyMeaningful:
      "No meaningful transactions yet. Send or receive funds to populate this view.",
    showZeroToggle: "show zero-amount transactions",
    hideZeroToggle: "hide zero-amount transactions",
  },
  wallet: {
    showAllChainsPrefix: "show all",
    showAllChainsSuffix: "chains",
    collapseChains: "collapse to active chains",
  },
  settings: {
    section: {
      security: "Security",
      system: "System",
      moneroNode: "Monero node",
      zephyrNode: "Zephyr node",
      miningSoftware: "Mining software",
      derivationCompat: "Derivation & wallet compatibility",
    },
  },
} as const;
