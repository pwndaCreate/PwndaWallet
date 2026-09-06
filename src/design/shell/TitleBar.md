# `<TitleBar>` (shell)

## Purpose

34px window-chrome bar with chromatic wordmark + sync chip + minimize/close. The standard portrait titlebar.

In a Tauri build, the bar has `data-tauri-drag-region` for window drag and renders the OS min/close buttons. In a web build (`dev:web`), the drag attr is omitted and the OS controls are hidden via `isTauri()` from `src/design/env.ts`.

## Variants / props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `syncLabel` | `string` | `"synced"` | Text after the dot |
| `syncColor` | `"green" \| "red" \| "amber" \| "gray"` | `"green"` | Maps to `<Dot color>` |
| `onMin` | `() => void` | — | Minimize handler (Tauri only) |
| `onClose` | `() => void` | — | Close handler (Tauri only) |
| `version` | `string` | `"v2.0.1"` | Shown after `wallet · ` |
| `middle` | `ReactNode` | — | Optional middle slot (e.g. breadcrumb) |

## Behaviors

From `src/design/BEHAVIORS.md`:

- **Chromatic-split wordmark** (signature) — via `<PwndaWordmark size={11} scan={false} />`.
- **Status dot pulse** (structural) — via `<Dot color={syncColor} />`.

## When to use / when NOT to use

**Use** as the portrait window titlebar. The full wallet and lite both use this — lite's `LiteTitleBar` composes on top of it with a different middle slot.

**Don't use** for landscape — landscape has its own `LandscapeShell` titlebar.

## Related

- `<PwndaWordmark>`, `<Dot>` — composed primitives.
- `src/design/env.ts::isTauri()` for the OS-controls guard.
