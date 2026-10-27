---
name: mobile-remote-ux
description: Mobile guest-remote UX rules for SingPulse's MobileRemoteView (spec §6.4.2) - thumb-zone layout, iOS Safari/Android Chrome quirks, debounced search, optimistic queueing, accessible queue sheet. Use when building or changing anything rendered on /remote.
---

# Mobile guest remote

Guests open `/remote?token=…` on iOS Safari or Android Chrome, often one-handed, in a dark room, on a
flaky tunnel connection. Follow spec §6.4.2 for features and the pocket-synth aesthetic. This skill
covers the execution details.

## Layout

- Use `min-h-dvh` (not `100vh`) and pad for `env(safe-area-inset-top/bottom/left/right)`. The sticky
  transport deck sits above the home indicator.
- Put primary actions (`QUEUE`, transport, sheet toggle) in the bottom thumb zone. Search and the
  handle live at the top.
- Touch targets are ≥ 44×44px, with ≥ 8px between adjacent destructive and non-destructive actions
  (e.g. `Trash2` vs a row tap).
- Form inputs use a `font-size` ≥ 16px, or iOS zooms the page on focus. Set `inputmode="search"`,
  `enterkeyhint="search"`, and `autocomplete="off"` on search.
- Design for widths from 360px to 430px, and check landscape so nothing overlaps.

## Singer identity

- Read and write `localStorage['singpulse_singer_name']` inside try/catch, because private mode can
  throw. Fall back to in-memory state.
- First run: prompt for a stage name before the first queue action. Keep the queue intent and finish it
  once the name is saved.
- The top bar shows the handle with an inline edit toggle. Trim the name, cap it at about 24 characters,
  and reject empty names.

## Search

- Debounce at 350 ms (spec). Cancel stale requests with `AbortController` so late responses never
  overwrite newer results.
- Treat states as distinct designed screens:
  - idle (a prompt to search)
  - loading (skeleton rows shaped like result rows)
  - results
  - empty ("NO MATCHES — TRY ARTIST + TITLE")
  - error (with retry)
- Result row: thumbnail (`loading="lazy"`, fixed aspect ratio so nothing shifts), cleaned title (two
  lines max), channel, `MM:SS` in `font-mono`, and the `QUEUE` button.

## Queueing

- Show `QUEUE` → `QUEUED` (acid-lime) optimistically, on tap. If `enqueueSong` fails, revert and show
  an inline error on that row.
- Prevent double-submits while a request is in flight.
- Use a short haptic (`navigator.vibrate?.(10)`) where supported, as an enhancement only.

## Transport deck and queue sheet

- The sticky deck shows the current track and singer, plus `Play/Pause`, `Restart`, and `Skip`
  (lucide `Play`/`Pause`, `RotateCcw`, `SkipForward`), each with an `aria-label`.
- The queue sheet is a bottom sheet with:
  - `role="dialog"`, `aria-modal="true"`, a labelled title
  - a focus trap, Esc and backdrop-tap to close, and focus returned to the toggle
  - a visible grab handle, with body scroll locked while it's open
- Queue rows show the fair-rotation order with mono indices (`01`, `02`), singer, title, and a status
  badge (`QUEUED` / `FETCHING` / `LOCKED IN`, mapping in `singpulse-design-language`). Removal uses
  `Trash2`, and should offer an undo.

## Connection

- Show the connection state as a quiet mono readout in the top bar (`LINK OK` / `RECONNECTING`). Never
  use a modal or full-screen blocker (spec §6.3).
- Disable actions that need the socket while it's disconnected. Keep the UI explorable.

## Accessibility

- Use semantic HTML: `<header>`, `<main>`, `<form role="search">`, `<ul>` for lists, and `<button>` for
  every action.
- Meet WCAG AA contrast. Show visible `focus-visible` rings. Announce `QUEUED` and errors through an
  `aria-live="polite"` region.

## Verify

Take Playwright screenshots at 390×844 and 360×740: first run (name prompt), empty search, loading,
results with one `QUEUED`, and the sheet open with mixed statuses. Emulate iPhone to check the
safe-area insets.
