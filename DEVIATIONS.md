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
