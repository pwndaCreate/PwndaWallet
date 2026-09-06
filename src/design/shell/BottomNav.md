# `<BottomNav>` (shell)

## Purpose

Five-tab bottom navigation: Wallet · Swap · Mine · Activity · Settings. Shown in the full wallet when a wallet exists.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `tab` | `TabId` | — | Active tab |
| `setTab` | `(t: TabId) => void` | — | Selection handler |

`TabId = "wallet" | "swap" | "mine" | "activity" | "settings"`

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Hover state transitions** (structural) — bg + border swap on `--motion-hover-duration`.

Active treatment: 1px accent top-border + `--accent-soft` fill + `--accent` text.

## When to use / when NOT to use

**Use** as the portrait-mode bottom nav for the full wallet.

**Don't use** for lite — lite has a 2-tab `LiteBottomNav` that doesn't reuse this. They're different navigation models.

## Related

- `<TitleBar>` for the matching top chrome.
- Lite-specific `LiteBottomNav` (in `src-lite/views/`) is the lite analogue.
