---
name: singpulse-design-language
description: How to execute SingPulse's "Tokyo Late-Night Vinyl Lounge / Teenage Engineering" design language (spec §6.1, §6.2, §6.4) with craft. Use before writing or restyling any Vue view, component, style.css, or index.html in packages/frontend.
---

# SingPulse design language

The direction is **fixed by the spec** (`.claude/agents/singpulse_architecture_agent_spec.md`
§6.1 tokens, §6.2 bans and visual language, §6.4 view requirements). Your job is not to choose a
direction. It is to execute this one so well that it reads as designed hardware, not a template.

## Precedence

1. The spec's words always win.
2. This skill, plus `tv-10ft-ui` and `mobile-remote-ux`.
3. The `frontend-design:frontend-design` plugin skill, used for craft discipline: type scale,
   restraint, self-critique, and copy.

The frontend-design skill lists some "AI tells": uppercase mono labels, `01`/`02` indices, near-black
backgrounds, acid accents. In SingPulse these are **deliberate spec choices**. Keep them, and make them
precise: tracking, alignment, and size relationships all have to be intentional.

## Before writing view code: the design plan

Write a short plan into your working notes (not a repo file) covering:

- **Type scale per surface** (TV at 1920×1080, mobile at 390×844). Display uses Syne uppercase
  `tracking-tighter`, body uses Plus Jakarta Sans, and metadata uses JetBrains Mono uppercase
  `tracking-widest`. Set ratios deliberately; don't just pick Tailwind steps at random.
- **Component inventory:**
  - TV: setlist ticker row, segmented status bar, ticket-stub/hardware-module QR card, broadcast HUD,
    equalizer SVG badge.
  - Mobile: top bar with handle edit, search field, result row, `QUEUE`→`QUEUED` button, sticky
    transport deck, queue sheet, status badge.
  - Define each one once and reuse it.
- **One signature motion moment.** Suggested: the TV song-change transition (setlist row slides into
  the HUD, or the vinyl groove spins up). Everything else stays still, or responds only to input.
- **Structure rules:**
  - Borders are 1px `border-white/12` (`/15` on the HUD).
  - Pick a deliberate radius scale, e.g. 2px for modules and full for pills. Don't use one radius
    everywhere.
  - No soft grey drop shadows. Express depth through surface tokens (`obsidian` → `surface` →
    `surface-elevated`) and borders.

Then check the plan against the §6.2 bans and fix anything that drifts toward stock SaaS UI before
coding.

## Token discipline

- Use only the §6.1 `@theme` tokens (`bg-obsidian`, `text-acid-lime`, `border-white/12`, `font-mono`,
  …). Components never contain raw hex values or Tailwind palette colors (`slate-*`, `indigo-*`,
  `gray-*`, …).
- If you need semantic names, add aliases **inside `@theme`** in `style.css`, e.g.
  `--color-status-ready: var(--color-acid-lime);`.
- Keep the status → visual mapping identical on TV and mobile:

  | `SongStatus` | Label | Treatment |
  |---|---|---|
  | `queued` | `QUEUED` | white/50 outline, empty segments |
  | `downloading` | `LOADING` | vinyl-amber, segments fill from `progress` |
  | `ready` | `READY` | acid-lime, all segments solid |
  | `playing` | `ON AIR` | acid-lime + equalizer |
  | `error` | `FAILED` + `errorMessage` | neon-coral |

## Contrast (WCAG AA)

- Text under 24px uses white (at ≥ 70% opacity) or acid-lime on obsidian or surface.
- Neon-coral (`#ff2a5f`) on obsidian is about 5:1. Check it again on `surface-elevated` before using it
  for small text. Prefer it for icons, large text, and destructive actions.
- Text on acid-lime fills (buttons, chips) is obsidian, never white.
- QR codes are always rendered dark-on-white inside their module, whatever the theme.

## Motifs and icons

- Grid lines and vinyl grooves are built with CSS (`repeating-linear-gradient`,
  `repeating-radial-gradient`) or inline SVG at 4–8% opacity. Use no images or `bg-gradient-*` (v3)
  utilities.
- The equalizer is an inline SVG whose bars animate `transform: scaleY()` with staggered delays. It is
  static under `prefers-reduced-motion`.
- Icons come only from `lucide-vue-next`, with one consistent `stroke-width` (e.g. 1.75) and size
  tokens. **No emoji anywhere** (UI, titles, logs shown to users).

## Fonts

Follow the spec: load Syne, Plus Jakarta Sans, and JetBrains Mono from Google Fonts in `index.html`,
with `preconnect` to both font hosts, only the weights you actually use, and `display=swap`. The TV or
LAN guests may have no internet route, so the fallback stacks in `@theme` must still look composed.
Check this by blocking fonts.googleapis.com in a Playwright screenshot once.

## Interaction and motion

- Every tactile button has a press state (`active:translate-y-px` plus a surface or border shift) and a
  visible `focus-visible` ring in acid-lime.
- Motion that responds to input is welcome when it shows what changed (`QUEUE`→`QUEUED`, sheet open).
- Ambient motion is limited to the signature moment and the equalizer.
- Wrap all non-essential animation in `motion-safe:`, or guard it with `prefers-reduced-motion`.

## Copy

- Every string names a control, reports state, or says what to do. No taglines, no eyebrows that
  restate a heading, no hints that repeat a nearby button.
- Keep the terse hardware-readout voice. Errors say what failed ("SEARCH FAILED"); add an action only
  when no button already offers it. "Oops! Something went wrong" is not allowed.
- Empty states are one short phrase ("QUEUE EMPTY").

## Self-critique loop

Run this after each view:

1. Build, then take Playwright screenshots: `/tv` at 1920×1080 (idle with a queue, and playback with
   the HUD), and `/remote` at 390×844 (empty, results, sheet open).
2. Check each one against the §6.2 bans, this skill, and the surface skill.
3. Remove one accessory: cut the element that does the least work.
4. Repeat until nothing reads as a default.
