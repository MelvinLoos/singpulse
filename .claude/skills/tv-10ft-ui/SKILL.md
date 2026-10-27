---
name: tv-10ft-ui
description: Android TV / Leanback 10-foot UI rules for SingPulse's TvPlayerView (spec §6.4.1) - legibility at 3 m, overscan, D-pad remote input, QR scannability, and WebView performance on low-end TV SoCs. Use when building or changing anything rendered on /tv.
---

# 10-foot UI for the TV receiver

The `/tv` route runs inside a Capacitor WebView on Android TV 10+ boxes. It is viewed from about 3 m
and controlled with a D-pad or IR remote. Follow spec §6.4.1 for layout and behavior. This skill covers
the constraints the spec leaves implicit.

## Canvas and legibility

- Design for a 1920×1080 CSS viewport. Many boxes report 960×540 at DPR 2, so check both.
- Keep all meaningful content within a **5% overscan-safe margin** (≈ 96px horizontal, 54px vertical at
  1080p). Backgrounds and motifs may bleed to the edge.
- The spec's mono metadata style (`font-mono text-xs tracking-widest uppercase`) describes the
  *treatment*, not the size. At 10 ft, `text-xs` (12px) can't be read. Scale TV sizes so that:
  - mono metadata (indices, statuses, token) is ≥ 20px
  - body text and singer names are ≥ 28px
  - the display brand is 96–160px
  Do this either by raising the root `font-size` on the TV view (preferred, since Tailwind's rem scale
  follows) or with TV-specific type tokens. Keep the uppercase, tracking, and mono styling.
- Limit setlist rows to the first 4 tracks (spec) and truncate titles with an ellipsis. Never wrap a
  title onto three lines.
- Use high contrast only: no text below 70% white on obsidian.

## QR codes

- Idle QR: `size=260`, `level="M"`. HUD QR: 72px (spec), `level="L"`.
- Always render dark modules on white with a quiet zone of at least 4 modules (padding inside the white
  card). Never apply tint, opacity, or blur to the QR itself.
- Test that the 72px HUD QR still scans from a phone at about 2 m on a real TV, or by screenshot at
  1:1 scale.

## Remote input

- Keybindings exactly per spec §6.4: `Enter`/`MediaPlayPause`/`Space` toggle pause,
  `MediaTrackNext`/`ArrowRight` skip, `ArrowLeft` restart. Call `preventDefault()` on handled keys
  only.
- Nothing may depend on hover. If any element becomes focusable, give it a ≥ 3px acid-lime
  `focus-visible` ring with offset, and a logical D-pad order.
- Remove the listener on unmount (spec), and never stack duplicate listeners across hot reloads.

## Performance (low-end TV SoCs)

- Animate only `transform` and `opacity`. Don't animate `width`, `height`, `top`, `box-shadow`, or
  `filter`. Segmented progress bars fill by toggling segment opacity or color, not width.
- The HUD's spec-mandated `backdrop-blur-md` over `<video>` stays, with a fallback:
  `@supports not (backdrop-filter: blur(1px)) { … bg-obsidian/95 … }`. If playback stutters on device,
  prefer the solid fallback and document it in `DEVIATIONS.md`.
- Keep the idle screen's DOM small. Don't use large animated SVG filters, and don't run more than one
  continuously animating element besides the equalizer.
- Use `will-change` sparingly, only on the element that is actually animating.

## Idle stage screen

- Drive the segmented status bars from the real `progress` (0–100) for `downloading` items. Don't fake
  progress with `animate-pulse`.
- Avoid burn-in: give static idle elements (brand, QR card) a very slow drift (a few px over 60 s+), or
  a subtle periodic shift. Disable it under `prefers-reduced-motion`.
- Show the connection state as a quiet readout (`ONLINE // TOKEN: …` or `RECONNECTING…`), never a
  modal (spec §6.3).

## Playback and errors

- `<video>` has `autoplay` and `playsinline`. Autoplay works because `MainActivity` disables the
  gesture requirement (spec §6.5), but still `catch()` the `play()` promise.
- When `@error` fires, the spec advances the queue. Surface a brief, legible readout on the next screen
  (e.g. `TRACK FAILED — SKIPPED`) so the room knows why.
- When paused, show a clear but unobtrusive paused state in the HUD.

## Verify

Take Playwright screenshots at 1920×1080: idle with an empty queue, idle with 4 queued tracks in mixed
statuses, and playback with the HUD. Squint test: are the singer name and the QR card the first things
you notice?
