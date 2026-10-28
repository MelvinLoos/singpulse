# Deviations from the architecture spec

The source of truth is [`.claude/agents/singpulse_architecture_agent_spec.md`](.claude/agents/singpulse_architecture_agent_spec.md).
The file tree, shared contracts (§4), environment variables and endpoints follow it exactly. This file
lists every place where the shipped code differs from the spec's reference code, and why. Each change
fixes a real bug, a toolchain incompatibility or a stated requirement the reference code missed.

## Toolchain & dependencies (§2)

| Change | Why |
| --- | --- |
| Pinned exact versions: the newest release *inside* each spec major (`@fastify/static` 8.3.0, `@fastify/cors` 10.1.0, Pinia 3.0.4, Vue Router 4.6.4, Capacitor 7.6.9, `@types/node` 24.x) | Several packages have shipped newer majors since the spec was written (Pinia 4, Router 5, Capacitor 8, `@fastify/static` 10). The spec's majors win; exact pins plus a committed lockfile keep builds reproducible. |
| `vue-tsc` + `typescript@6` added to the frontend dev deps | `tsgo` can't type-check `.vue` SFCs. `tsgo` still checks the `.ts` files (with a `*.vue` module shim in `src/env.d.ts`), and `vue-tsc --noEmit` checks the SFC templates. Nothing is emitted. |
| `noUncheckedIndexedAccess`, `isolatedModules`, `skipLibCheck` added to both tsconfigs, on top of the mandated options | Stricter index safety (singpulse-stack skill). The mandated options are all present unchanged. |

## Backend

### `ytdlp.ts` (§5.2)

| Change | Why |
| --- | --- |
| Search sanitizer `/[^\w\s-]/gi` → `/[^\p{L}\p{N}\s'-]/gu` | `\w` is ASCII-only, so "Beyoncé" became "Beyonc" and Japanese queries were erased entirely. The query is passed as an `execFile` argument behind the `ytsearch10:` prefix, so it cannot inject flags. |
| Concurrent downloads of the same `videoId` share one in-flight promise | Two queue entries for one video raced two `yt-dlp --no-part` processes writing the same file. |
| A partial output file is deleted when a download fails or times out | With `--no-part`, a killed download leaves a truncated `.mp4` that `existsSync` would serve as a cache hit forever. |
| `utimes` on cache hits | Eviction sorts by mtime. Without touching hits it was FIFO, not the LRU the spec describes (§5.1). |
| Optional `onProgress` callback, using `--newline --progress-template` | `QueueItem.progress` exists in the contract but was never populated, so the TV's segmented status bars could not reflect real progress. The video stream maps to 0–90 % and the audio stream to 90–100 %, so the bar never moves backwards. |
| Errors re-thrown as short messages (`yt-dlp is not installed on the server`, `Download timed out`, the `ERROR:` line from yt-dlp) | Raw `execFile` errors embed the full command line and stderr, which ended up in `errorMessage` and were shown to guests. |
| `sort` → `toSorted` | Lint-clean (oxlint `no-array-sort`); same behaviour. |

### `queueManager.ts` (§5.3)

| Change | Why |
| --- | --- |
| Pre-fetching is capped by `3 - activeDownloads.size` | The reference picked "the first 3 *queued*" items on every call, excluding ones already downloading. Ten quick enqueues therefore started ten yt-dlp processes. |
| `processQueue()` runs again after each download completes or fails | Otherwise the pipeline stalled while a song was playing until someone enqueued or removed a track. |
| Progress is re-broadcast only when a 10 % segment changes | Avoids a WebSocket storm. The UI renders 10 segments. |
| `for (const [i, queued] of this.queue.entries())` instead of `this.queue[i]` | Required by `noUncheckedIndexedAccess`; same algorithm. |

### `server.ts` (§5.4)

| Change | Why |
| --- | --- |
| JSON schemas on `/api/search`, `/api/queue` (with unknown fields stripped) and `/api/queue/:id` | The skill requires validating every inbound boundary. A blank singer name or a malformed `videoId` now gets a 400 instead of reaching the queue. |
| Inbound WebSocket messages are parsed field-by-field, with a 4 KiB `maxPayload` | The reference cast arbitrary JSON to `WsInboundMessage`, so any `command.action` string was rebroadcast to every client. |
| `?token=` is redacted in Fastify request logs | The default request serializer logged every guest's party token. |
| `/api/search` returns 502 `Search unavailable` when yt-dlp fails | Previously this was an unhandled rejection surfaced as a generic 500. |
| `GET /api/health` (unauthenticated, returns `{ ok: true }`) | Used by the Docker `HEALTHCHECK`. |
| `GET /api/stats` (new `STATS_API_KEY` env var) returns party metrics shaped for gethomepage/homepage's `customapi` widget; `docker-compose.yml` gains `homepage.*` discovery labels | Dashboard integration. Without a key it is LAN-only (`isTrustedLanRequest`), so tunnel guests cannot read singer names. With a key, every request must send `x-api-key` (constant-time compare). The party token is never included. |
| CORS `origin: true` replaced by an allow-list (same host or `PUBLIC_REMOTE_URL` origin), also enforced on every request including the `/ws` upgrade, which returns 403 otherwise | Cross-site WebSocket hijacking. WebSockets ignore CORS, and LAN clients are trusted by IP. Under the old rule, any web page a LAN guest opened could connect from the guest's browser, read `STATE_SYNC` (including the party token) and control playback. Requests without an `Origin` header (non-browser clients) are unaffected. |
| Token check uses a constant-time comparison, and locks a client out after 20 *distinct* wrong tokens in 15 minutes | The spec's 6-char hex token has only about 16.7M possibilities, which is brute-forceable through a public tunnel. Counting only distinct guesses means a phone that keeps reconnecting with one stale token never gets locked out. Clients are keyed by `cf-connecting-ip` only when the peer is a local (tunnel) address. |
| SIGINT/SIGTERM call `app.close()` | Node runs as PID 1 in the container and ignores signals without handlers, so `docker stop` waited 10 s and then sent SIGKILL. |

## Frontend

| Change | Why |
| --- | --- |
| `searchSongs(query, signal?)` takes an optional `AbortSignal` | The mobile-remote skill requires cancelling stale searches so late responses never overwrite newer results. |
| `enqueueSong` / `removeQueueItem` throw when the response is not `ok` | Optimistic `QUEUE → QUEUED` needs to know when to roll back. |
| `JSON.parse` in the socket handler is wrapped in `try/catch` | One malformed frame would otherwise throw inside the event handler. |
| Socket handlers use `addEventListener` instead of `onopen = …` | oxlint `prefer-add-event-listener`; same behaviour. |
| `registerCommandHandler` accepts `null`; the store also exposes `remoteBaseUrl` | Lets the TV view unregister on unmount, and lets the QR module show the join host. |
| TV: if the browser rejects unmuted autoplay, playback retries muted and shows `SOUND OFF // PRESS OK TO UNMUTE` | `MainActivity` unlocks autoplay inside the APK, but `/tv` opened in an ordinary browser (a laptop on HDMI) would otherwise stall silently while showing ON AIR. |
| TV playback HUD split in two: now playing (status, singer, song, artist) in the lower left, next mic + join QR in the upper right. Both panels are 55 % obsidian glass. The HUD QR is 8rem (192px at 1080p) instead of 72px | The single opaque panel covered the karaoke lyrics. At 72px a join URL's modules are under 2px each, too small to scan from the couch. The artist comes from splitting the conventional `Artist - Song` upload title (`splitArtist`), since `QueueItem` has no artist field. |
| TV `@ended` / `@error` call small handler functions | Same behaviour as the inline `store.notifySongEnded(store.currentSong.id)`, but type-safe when `currentSong` changes between render and event. |

## Container & deployment (§7)

| Change | Why |
| --- | --- |
| `corepack prepare pnpm@latest` removed; pnpm comes from `packageManager` (`pnpm@10.34.9`) | `latest` is now pnpm 12, which contradicts the pnpm 10 requirement (§2) and makes builds non-reproducible. |
| `pnpm install --frozen-lockfile` with `--filter` in place of `--frozen-lockfile=false` | Reproducible installs. The runtime stage installs only `@singpulse/backend...` production deps. All workspace manifests are copied so the lockfile matches. |
| Runtime drops to the `node` user through `docker/entrypoint.sh` (`setpriv`), after `chown` of `CACHE_DIR` | Avoids running yt-dlp and ffmpeg (which parse untrusted media) as root. Docker creates a missing `./singpulse-cache` bind mount as root, so the entrypoint fixes its ownership first. |
| `/etc/yt-dlp.conf` with `--js-runtimes node` | Current yt-dlp needs a JavaScript runtime to solve YouTube challenges and only enables Deno by default. Node 24 is already in the image. |
| `curl -fsSL` and purge `curl` after use; `HEALTHCHECK` | `-f` fails the build instead of saving an HTML error page as the binary. The healthcheck backs Docker/Watchtower restarts. |
| Compose: `MAX_CACHE_GB=${MAX_CACHE_GB:-25}` | Same default, but overridable from `.env`. |
| Compose: `PARTY_TOKEN=${PARTY_TOKEN:-}` instead of `${PARTY_TOKEN:-pulse26}` | A default token published in the repository offers no protection on an internet-facing tunnel. When unset, the server generates a random token per start, as described in §5.1. |
| Compose: `DOCKER_API_VERSION=1.44` on watchtower | Docker Engine 29 rejects the API version watchtower negotiates by default, so it would crash-loop. |

## CI/CD (§8)

| Change | Why |
| --- | --- |
| `pnpm/action-setup` without `version: 10` | The action errors out when `version` and the `packageManager` field are both set and differ (`10` vs `10.34.9`). The `packageManager` field still pins pnpm 10. |
| `pnpm lint` (pinned oxlint) instead of `pnpm dlx oxlint` | Uses the locked version instead of whatever is newest that day. |
| Docker workflow also runs typecheck and tests; builds `linux/amd64,linux/arm64` with QEMU, Buildx and the GHA layer cache, and applies OCI labels | §1.2 names ARM64 hosts, but the reference built amd64 only. |
| APK workflow: `permissions: contents: read`, `pnpm exec cap`, `--frozen-lockfile`, `if-no-files-found: error` | Least privilege (uploading an artifact needs no write access). `pnpm exec` uses the pinned Capacitor CLI. A missing APK now fails the build. |
| New `ci.yml` (lint, typecheck, test, native-TS check, build) on pull requests and on `main` | Quality gate before merge; the spec's workflows only run after code lands on `main`. |
| Concurrency groups on all workflows | Cancel superseded runs. |

## Host Mode (admin controls)

| Change | Why |
| --- | --- |
| `STATE_SYNC.partyToken` is optional and only sent to sockets that connect with `role=tv` from a trusted LAN address; `?role=tv` is appended by `TvPlayerView` | Broadcasting the live token to every client would hand a kicked guest the new token the moment a rotation happens. Guests and the host keep the token they hold; the host receives the new one in the `rotate-token` response. |
| `/api/admin/*` needs both the party token and `x-admin-pin` (header, or `pin` in the body); 10 wrong PINs per 15 min per client answers 429 | The 4-digit default PIN is brute-forceable without a limit. Admin routes must not be reachable by a mere LAN-trusted guest without the PIN. |
| `ADMIN_PIN` falls back to `1234`; compose uses `${ADMIN_PIN:-1234}` | Requested default for dev. Set your own for any internet-facing tunnel. |
| Rotation closes every non-TV socket (including the host's); the host store reconnects itself with the new token | Matches the requested close code `4001` / `PARTY_TOKEN_ROTATED`. LAN-trusted clients need no token, so they rejoin immediately after a rotation. |
| Close-code constants are not in `@singpulse/shared` | Shared is type-only (value imports from `node_modules` crash under native TS stripping). |

## Crowd vote + Polaroid wall

| Change | Why |
| --- | --- |
| The vote hooks into `QueueManager.handleSongEnded` (WS `SONG_ENDED`), not an `advance()` / `POST /api/next` | Those do not exist; the TV `ended` event already arrives as `SONG_ENDED`. Host skips (`skipCurrent`) open no vote. A TV `onerror` also sends `SONG_ENDED`, so a failed track opens a vote too. |
| New inbound WS messages `SUBMIT_VOTE` and `SKIP_VOTE` (TV socket only); `STATE_SYNC` gains `activeVote` and `polaroids`; new outbound `POLAROID_BURST` | Votes are small, so they use the existing socket. `SKIP_VOTE` is TV-only so guests cannot cut the intermission short. |
| `POST /api/polaroid` (REST, 500 KB body limit) rather than a WS message | The WS `maxPayload` is 4096 bytes. Rate limit is 1 photo per 15 s per `clientKey`. |
| Polaroids persist in `${CACHE_DIR}/polaroids` (`index.json` plus image files, newest 200 kept) and are served by the existing `/media/` mount; `DELETE /api/admin/polaroid/:id` removes one | Photos survive container restarts and feed the idle-screen wall. |
| `--color-film-paper` (`#f4f1ea`) added to `@theme` | The requested film-border colour, kept as a token so raw hex stays out of components. |

## PWA (installable guest remote)

Not in the spec; additive. Nothing in §4 (shared contracts) changed.

| Change | Why |
| --- | --- |
| `vite-plugin-pwa` 2.0.0, `workbox-window` 7.4.1 and `@vite-pwa/assets-generator` 2.0.0 (frontend dev deps); committed icons in `packages/frontend/public/` (`pnpm --filter @singpulse/frontend pwa:assets` regenerates them from `pwa/icon.svg`) | Manifest, auto-updating service worker and home-screen icons. Icons are committed so Docker and CI need no image tooling. No iOS splash images: iOS builds the launch screen from the touch icon and `background_color`. |
| Service worker scope `/`, registered only from `/remote`; `/api`, `/media`, `/ws` and `/tv` are never served from its cache | The TV and the MP4 range requests must never be intercepted. It only registers in a secure context, so guests on the HTTPS tunnel get it and plain-HTTP LAN guests do not. |
| `GET /api/video/:videoId` (returns the existing `SearchResult`) with an in-memory 100-entry cache | Share-to-queue: a YouTube link shared into the app resolves to a result row. Same auth as `/api/search`. |
| `@fastify/static` for the SPA now sets `Cache-Control`: `no-cache` for `sw.js`, `workbox-*.js`, `manifest.webmanifest` and `index.html` (also on the SPA fallback), `immutable` for `/assets/*` | A stale worker or shell pinned by a browser or the Cloudflare edge would stop guests getting updates. |
| The party token is also kept in `localStorage['singpulse_party_token']`; a rejected token shows a code-entry panel instead of a dead end | A home-screen launch has no `?token=`, and iOS home-screen apps do not share storage with Safari, so a rescan cannot help. |
| WebSocket reconnect: capped exponential backoff (1 to 15 s) instead of a fixed 2 s, a liveness check on resume and a 4 s ping watchdog | Phones freeze sockets when the screen sleeps. |

## Trivia Blitz (opt-in OpenTDB party quiz)

Not in the spec; additive. `ServerStatePayload` gains `activeTrivia`; nothing else in §4 changed.

| Change | Why |
| --- | --- |
| The lobby guards `currentSong`, `activeVote` and an already-open game (409). There is no intro quiz in the codebase to guard against. | The requested guard list names a feature that does not exist. |
| Scores, streaks and `lastAnswerCorrect` are computed at answer time but only written to the public `players` at REVEAL (private per-round map in `QueueManager`). `correctOptionId` is only present in REVEAL. | `STATE_SYNC` goes to every phone, so publishing results early would leak who was right. |
| `lockedInCount` is always derived from `players` (`hasAnsweredCurrent`), never incremented. A 51st auto-enrolling answer is refused with 409. | Joins, leaves and answers cannot drift apart. |
| `api.php` calls are spaced 5.1 s apart (OpenTDB code 5); `api_token.php` is never gated. Starting a game waits at most 6.5 s for the prefetch, then uses the offline bank. | A token refresh plus retry must finish inside the wait, and a slow API must not stall the room. |
| If the last player leaves mid-game, the game ends and the queue resumes. In the lobby it stays open. | Nobody is playing; the karaoke queue should not be held hostage. |
| `advancePlayback()` is blocked while trivia is active; downloads continue. Ending trivia (stop, podium timeout, empty roster) promotes the first ready song. | Requested queue behaviour. |
| `/api/stats` and `PartyStatus` are unchanged (trivia reads as `idle`). | Keeps the dashboard contract stable. |
| The TV has no idle audio today, so nothing is ducked. Any future idle audio must be gated on `!store.activeTrivia`. | Avoids clashing with `triviaSounds.ts`. |
| `SegmentBar` accepts a plain 0-1 `fill` (and `tone`) next to the queue-item mode. | The 14 s countdown reuses the same segmented bar. |
| `TriviaPlayer.playerId` in `STATE_SYNC` is a salted HMAC of the phone's `voterId`, not the `voterId` itself. The request bodies still carry the `voterId` as `playerId`; `join` and `answer` return the public id, which the phone keeps in `sessionStorage['singpulse_trivia_player']`. | `STATE_SYNC` reaches every phone, so broadcasting the `voterId` would let anyone kick a player or answer for them, and cast their crowd votes. A reload within a game restores the id; if it is lost, tapping JOIN again recovers it (join is idempotent). |
