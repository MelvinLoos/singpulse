# SingPulse

Self-hosted karaoke for house parties. A headless server finds and caches karaoke tracks with
`yt-dlp`. An Android TV app acts as the stage display, and guests queue songs from their phones by
scanning a QR code. Nobody needs to install anything except the TV.

```
 Guest phones ──HTTPS──▶ Cloudflare Tunnel ──┐
 (iOS Safari / Chrome)    ?token=PARTY_TOKEN  │
                                              ▼
 Guest phones ──HTTP (LAN)──────────▶  SingPulse server  ◀── yt-dlp + ffmpeg ── YouTube
                                       Node 24 · Fastify 5
                                       :3000  /remote  /tv  /ws  /api  /media
                                              ▲
 Android TV (Capacitor APK) ──HTTP, static LAN IP──┘   (no token needed on the LAN)
```

- **Fair rotation.** Every singer gets a turn before anyone sings twice.
- **Background pre-fetch.** Up to three upcoming tracks download at once as H.264/AAC MP4
  (≤1080p, hardware-decodable on TV boxes). SponsorBlock cuts non-singing intros and outros.
- **Resilient realtime.** A single WebSocket keeps a 15 s heartbeat and reconnects silently.
- **Tunnel-safe.** LAN clients are trusted. Anything arriving through Cloudflare must present the
  party token.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/shared` | WebSocket and REST contracts (`@singpulse/shared/types`), types only |
| `packages/backend` | Fastify server, queue engine and yt-dlp media service. Runs `.ts` natively on Node 24, with no build step |
| `packages/frontend` | Vue 3.5 + Vite 8 + Tailwind v4 app: `/tv` stage receiver and `/remote` guest controller |
| `packages/frontend/android-tv-template` | Leanback manifest and autoplay `MainActivity`, applied after `cap add android` |
| `Dockerfile`, `docker-compose.yml`, `docker/` | Production image (multi-arch) and deployment stack |
| `.github/workflows` | CI gate, GHCR image publishing, Android TV APK build |
| `DEVIATIONS.md` | Where and why the code departs from the architecture spec |

## Deploy the server

Requirements: a Linux host (x86_64 or ARM64) with Docker Engine and a **static LAN IP**.

1. Create a `.env` next to `docker-compose.yml`:

   ```dotenv
   GITHUB_REPOSITORY=<owner>/<repo>          # lowercase, e.g. melvinloos/singpulse
   PARTY_TOKEN=<something-unguessable>       # required by guests coming through the tunnel
   PUBLIC_REMOTE_URL=https://sing.example.com
   MAX_CACHE_GB=25
   ```

2. Start the stack:

   ```sh
   docker compose up -d
   docker compose logs singpulse | grep "Party Token"
   ```

   Watchtower polls GHCR every 5 minutes and restarts SingPulse when CI publishes a new image. CI
   also rebuilds the image weekly to pick up the latest `yt-dlp`.

3. *(Optional)* Expose guests to the internet with a Cloudflare Tunnel that points
   `sing.example.com` at `http://<server-lan-ip>:3000`. Tunnel traffic always carries
   `cf-connecting-ip`, so it must present the token. The TV QR code embeds it automatically.

To build the image locally instead of pulling it: `docker build -t singpulse .`

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket listen port |
| `PARTY_TOKEN` | random 6-char hex | Token required for non-LAN / tunnel clients (`?token=` or `x-party-token`) |
| `PUBLIC_REMOTE_URL` | `http://localhost:3000` | Base URL encoded into the TV's join QR code |
| `CACHE_DIR` | `/app/cache` | Where downloaded MP4s are stored (mount a volume here) |
| `MAX_CACHE_GB` | `25` | Least-recently-used tracks are evicted above this size |
| `FRONTEND_DIST` | `packages/frontend/dist` | Built SPA served by the backend (set in the image) |

## Install the Android TV receiver

The APK is a thin Capacitor 7 WebView that opens `http://<server-lan-ip>:3000/tv` directly. Using the
IP rather than a hostname sidesteps router DNS-rebinding filters. The URL is baked in at build time.

1. **Actions → Build SingPulse Android TV APK → Run workflow**, and enter your server's LAN URL
   (e.g. `http://192.168.1.50:3000/tv`). Pushes to `main` use the `CAP_SERVER_URL` repository variable
   instead, falling back to `http://192.168.1.100:3000/tv`.
2. Download the `singpulse-tv-apk` artifact and sideload it:

   ```sh
   adb connect <tv-ip>:5555
   adb install -r app-debug.apk
   ```

3. Launch **SingPulse TV** from the Android TV home screen. The remote's D-pad works as follows:

   | Key | Action |
   | --- | --- |
   | OK / Enter, Play-Pause, Space | Toggle pause |
   | Right, Next track | Skip |
   | Left | Restart track |

The receiver also runs in any browser at `/tv`, for example on a laptop connected over HDMI. If that
browser blocks unmuted autoplay, playback starts muted and the next key press restores sound.

## Develop

Requirements: Node ≥ 24 and corepack (`corepack enable`). pnpm is pinned through `packageManager`.

```sh
pnpm install
pnpm dev            # backend (node --watch) on :3000 + Vite on :5173 with /api, /media, /ws proxied
```

Then open `http://localhost:5173/tv` and `http://localhost:5173/remote`. Search and downloads need
`yt-dlp` and `ffmpeg` on your `PATH`.

| Command | What it runs |
| --- | --- |
| `pnpm lint` | oxlint across the monorepo |
| `pnpm typecheck` | `tsgo --noEmit` (backend + frontend) and `vue-tsc --noEmit` (SFCs) |
| `pnpm test` | `node:test` suites for the queue engine and media service (yt-dlp is mocked) |
| `pnpm build` | Vite 8 production build of the frontend |
| `pnpm check` | All of the above, the same gate CI runs on pull requests |

Conventions: Conventional Commits, exact dependency pins, erasable TypeScript only (no `enum` or
`namespace`, and shared types are imported with `import type`). There is no transpile step anywhere.

## Security model

- Requests from RFC 1918 or loopback addresses **without** a `cf-connecting-ip` header are trusted.
  Everything else needs the party token. Don't put a plain reverse proxy on the LAN in front of
  SingPulse: all of its traffic would look local and be trusted.
- Browsers may only reach the API and WebSocket from pages served by SingPulse itself or from
  `PUBLIC_REMOTE_URL`, so other websites can't drive the party through a guest's browser.
- A client that sends 20 different wrong tokens is locked out for 15 minutes.
- `yt-dlp` is only ever spawned via `execFile` with argument arrays. Video ids are validated against
  the 11-character YouTube format, and every REST body and WebSocket message is schema-checked.
- Party tokens are redacted from request logs. The token is printed once at startup for the host.
- The container runs as the unprivileged `node` user.
