---
name: singpulse-stack
description: Engineering conventions, toolchain pitfalls, and the verification ladder for the SingPulse monorepo (pnpm 10, Node 24 native TypeScript, Fastify 5, Vue 3.5 + Vite 8 + Tailwind v4, Capacitor 7, Docker/GHCR). Use before scaffolding, adding dependencies, writing backend/frontend code, or claiming any task is done.
---

# SingPulse stack conventions

The source of truth is `.claude/agents/singpulse_architecture_agent_spec.md`. This skill covers what
the spec leaves implicit.

## Deviation rule

- The file tree (§3), shared contracts (§4), env vars, endpoints, and behavior follow the spec
  **exactly**.
- If spec code has a real bug (it crashes, fails typecheck, or breaks a stated requirement), make the
  minimal fix. Log it in a root `DEVIATIONS.md` entry with the spec section, what changed, and why.
- Never "improve" contracts or rename things silently.

## Toolchain bootstrap

- pnpm is not installed globally on this machine (Node is v24.14). Bootstrap with `corepack enable`
  and set `"packageManager": "pnpm@10.x.y"` in the root `package.json`.
- Before installing, check each current major against the spec via context7 or `pnpm view <pkg>
  version`. Pin exact versions (`save-exact=true` in `.npmrc`).
- There is no `babel`, `ts-node`, `tsx`, `webpack`, or `tsc` emit step (spec directive).

## Node 24 native TypeScript (backend and shared)

- Node strips types natively, so only **erasable syntax** is allowed: no `enum`, `namespace`, parameter
  properties (`constructor(private x)`), or `import x = require()`.
- In tsconfig, use `"erasableSyntaxOnly": true`, `"verbatimModuleSyntax": true`,
  `"allowImportingTsExtensions": true`, `"noEmit": true`, `"module": "nodenext"`, `"strict": true`, and
  `"noUncheckedIndexedAccess": true`.
- Relative imports include the `.ts` extension (`./queueManager.ts`).
- Shared types are imported **only** with `import type … from '@singpulse/shared/types'`. Node refuses
  to strip `.ts` under `node_modules`, and the pnpm-linked shared package lives there, so a value import
  would crash at runtime.
- `packages/shared/package.json`: `"exports": { "./types": "./src/types.ts" }`, with no runtime deps.

## Backend (Fastify 5)

- Spawn `yt-dlp` with `execFile`/`spawn` argument arrays only. Never use a shell, and never interpolate
  into a command string.
- Validate every inbound boundary: query, body, params, and WS messages. Prefer Fastify JSON schemas on
  routes. Parse WS messages defensively and ignore unknown `type` values.
- Don't log the party token except in the deliberate startup line from the spec. Never log request
  tokens.
- Keep media serving on `@fastify/static` with range support (§5.4).

## Frontend (Vue 3.5, Vite 8, Tailwind v4, Pinia 3)

- Use `<script setup lang="ts">` and the Composition API only. Use typed `defineProps` and
  `defineEmits`.
- Clean up every listener, timer, and AbortController in `onUnmounted`.
- Tailwind v4 is CSS-first: `@import "tailwindcss";` plus `@theme` in `src/style.css`. Don't create a
  `tailwind.config.js`.
  - Use v4 utility names: `bg-linear-to-*` instead of `bg-gradient-to-*`, `shadow-xs`/`shadow-sm`
    renames, and `outline-hidden`.
  - Use context7 for Tailwind v4 docs when unsure. Don't rely on v3 memory.
- Icons come from `lucide-vue-next` (tree-shaken named imports). No emoji.
- Styling rules live in the `singpulse-design-language`, `tv-10ft-ui`, and `mobile-remote-ux` skills.

## Capacitor 7 / Android TV

- Keep `android-tv-template/` overrides exactly as in the spec (§6.5). `android/` is generated in CI
  and is not committed. Add it to `.gitignore`.

## Verification ladder

Run every step and show the output before claiming done:

1. `node --check packages/backend/src/server.ts` (plus the other backend files).
2. `pnpm dlx @typescript/native-preview --noEmit -p packages/<pkg>` for each package (`tsgo`; in the
   frontend, also typecheck `.vue` files, using `vue-tsc` only if tsgo can't).
3. `pnpm dlx oxlint` with zero errors.
4. `pnpm --filter @singpulse/frontend build` with zero errors.
5. Boot smoke test:
   - Start the backend with a temp `CACHE_DIR`. `curl -s localhost:3000/api/search?q=test` returns
     JSON, or a clear error if yt-dlp is missing.
   - A WS connect to `/ws` receives `STATE_SYNC`, and a `PING` gets a `PONG`.
   - `/tv` and `/remote` serve `index.html`.
6. For UI work: the Playwright screenshot review from the design skills.
7. A grep audit across `packages/frontend/src`:
   - no emoji
   - no raw hex outside `style.css`
   - no `bg-gradient-` / `slate-` / `indigo-` classes
   - no `any`

If a step can't run here (no yt-dlp, no Docker, no Android SDK), say so explicitly. Don't skip it
silently.
