# KvRow

Generic key/value row. Label on the left, value on the right, aligned with `justify-content: space-between`.

## Purpose

Label/value pairs in stat cards, quote breakdowns, metadata rails. Replaces inline JSX in `MineLandscapeView`, `SwapLandscapeView`, `WalletLandscapeView`.

## Variants

- `tnum` (default `true`) — apply tabular-nums to the value, so numbers don't shift width as digits change.
- `accent` — color the value with `--accent` instead of `--text`.
- `upper` (default `true`) — label uppercase + tracked. Pass `upper={false}` to render the label in mixed case (used for the post-T3.3 "ease of use" sentence-case fields).

## Behaviors

None. No animation, no hover, no focus state. Use inside a `<Card>` if you want the v2 fade-in on mount.

## When to use

- Earnings breakdown (`per hour 0.001 XMR`)
- Swap quote line (`fee 0.15%`)
- Vault metadata (`encryption AES-256-GCM`)

## When NOT to use

- Form fields — use `<input>` with a `<label>` directly.
- Section headings — use a `<Card title>` instead.
- Stat numbers that need a hero treatment — use `<StatTile>` (in `src/features/mining/components/`) for the bordered box style.

## Related

- [[design-system]]
- [[ease-of-use-improvement-plan]] § T3.1
