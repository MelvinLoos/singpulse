# SYSTEM SPECIFICATION: "SingPulse" (Headless Server + Android TV Receiver)

> **AGENT EXECUTION DIRECTIVE:** This document is the single source of truth for scaffolding, building, testing, and deploying the `singpulse` monorepo. Follow the exact file tree, dependency versions, type contracts, and architectural constraints defined below. Do not introduce legacy transpilers (`babel`, `tsc` build steps, `ts-node`, `webpack`).

---

## 1. System Overview & Target Architecture

### 1.1 Problem Statement
Legacy self-hosted karaoke systems (e.g., PiKaraoke) suffer from unstable Socket.IO polling, lack authentication for public tunnel exposure, and fail on locked-down Smart TVs and Android TV boxes due to router DNS rebinding filters and browser autoplay restrictions.

### 1.2 Hardware & Network Topology
* **Backend Host:** Headless Linux Server / Mini PC (x86_64 or ARM64 running Docker Engine).
* **TV Receiver Client:** Any Android TV device (running Android TV 10+, hardware H.264/AAC decoding, physical Bluetooth/IR D-pad remote).
* **Mobile Clients:** Guest smartphones (iOS Safari / Android Chrome) connecting via a Cloudflare Tunnel (`https://sing.<domain>/remote?token=<PARTY_TOKEN>`) or local Wi-Fi.
* **Network Constraint Bypass:** Many consumer routers enforce DNS rebinding protection that blocks local domains. Therefore, the Capacitor Android TV APK connects **directly via static LAN IP over HTTP** (`http://<SERVER_LAN_IP>:3000/tv`), while mobile guests connect via the authenticated HTTPS Cloudflare Tunnel or LAN IP.

---

## 2. Technology Stack & Dependency Matrix (2026 Rust/TS Toolchain)

* **Monorepo Manager:** `pnpm` (v10.x) with workspaces (`pnpm-workspace.yaml`).
* **Backend Runtime:** **Node.js 24 LTS** (`node:24-bookworm-slim`) executing `.ts` files natively (`node --watch src/server.ts` in dev, `node src/server.ts` in prod) via built-in Amaro/SWC type-stripping. Zero backend build step.
* **Backend Framework:** `fastify` (v5.x), `@fastify/websocket` (v11.x), `@fastify/static` (v8.x), `@fastify/cors` (v10.x), and `@types/ws` + `@types/node` (v24.x).
* **Media Pipeline:** `yt-dlp` (latest standalone binary) + `ffmpeg` with SponsorBlock segment removal and H.264 (`avc1`) + AAC (`mp4a`) stream enforcement.
* **Frontend Framework:** **Vue 3.5+** (Composition API, `<script setup lang="ts">`), **Vue Router 4**, **Pinia 3**, `qrcode.vue`, `lucide-vue-next` (clean geometric iconography—NO emojis).
* **Frontend Build Engine:** **Vite 8** (powered by **Rolldown** & **Oxc** Rust compiler) + **Tailwind CSS v4** (`@tailwindcss/vite`).
* **Typechecking & Linting:** `@typescript/native-preview` (`tsgo --noEmit`) and `oxlint` (Rust-powered linter).
* **TV Native Wrapper:** **Capacitor 7** (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`) compiled into an Android TV Leanback APK.

### 2.1 Critical TypeScript & Node 24 Constraints
To ensure `node src/server.ts` and `tsgo --noEmit` succeed without a build step, all `tsconfig.json` files MUST include:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true
  }
}
```
* **No `enum` or `namespace`:** Node 24 native type-stripping requires `erasableSyntaxOnly: true`. Use union types (`type Status = 'a' | 'b'`) instead of TypeScript `enum`.
* **Workspace Imports:** In `packages/shared/package.json`, set `"exports": { "./types": "./src/types.ts" }` so both Node 24 and Vite 8 resolve `@singpulse/shared/types` cleanly.

---

## 3. Monorepo Directory Structure

The coding agent MUST generate the following exact directory structure:

```text
singpulse/
├── .github/
│   └── workflows/
│       ├── docker-publish.yml       # Auto-builds & pushes Server Docker image to GHCR
│       └── android-tv-apk.yml       # Auto-compiles Capacitor Android TV APK artifact
├── packages/
│   ├── shared/                      # Shared TypeScript interfaces (Zero runtime deps)
│   │   ├── package.json
│   │   └── src/
│   │       └── types.ts
│   ├── backend/                     # Node 24 native TS server + yt-dlp orchestrator
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── server.ts
│   │       ├── queueManager.ts
│   │       └── ytdlp.ts
│   └── frontend/                    # Unified Vue 3 + Vite 8 + Capacitor 7 app
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── index.html
│       ├── capacitor.config.ts
│       ├── src/
│       │   ├── main.ts
│       │   ├── App.vue
│       │   ├── style.css
│       │   ├── router/
│       │   │   └── index.ts
│       │   ├── stores/
│       │   │   └── karaoke.ts
│       │   └── views/
│       │       ├── TvPlayerView.vue
│       │       └── MobileRemoteView.vue
│       └── android-tv-template/     # Drop-in overrides applied after `cap add android`
│           ├── AndroidManifest.xml
│           └── MainActivity.java
├── Dockerfile                       # Multi-stage build (Vite 8 dist + Node 24 + yt-dlp)
├── docker-compose.yml               # Production deployment stack
├── pnpm-workspace.yaml
└── package.json
```

---

## 4. Shared Data Contracts (`packages/shared/src/types.ts`)

All WebSocket messages and REST payloads strictly adhere to these TypeScript types:

```typescript
// packages/shared/src/types.ts

export type SongStatus = 'queued' | 'downloading' | 'ready' | 'playing' | 'error';

export interface QueueItem {
  id: string;              // UUID v4 for this specific queue entry
  videoId: string;         // 11-char YouTube Video ID
  title: string;           // Cleaned track title
  singer: string;          // Name of guest who queued the track
  duration: number;        // Duration in seconds
  thumbnail: string;       // URL to YouTube thumbnail
  status: SongStatus;
  progress?: number;       // Download progress percentage (0-100)
  mediaUrl?: string;       // Populated when status === 'ready' | 'playing' (e.g., '/media/dQw4w9WgXcQ.mp4')
  errorMessage?: string;
}

export interface SearchResult {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
  channel: string;
}

export interface PlaybackCommand {
  action: 'toggle_pause' | 'skip' | 'restart' | 'volume';
  value?: number;
}

export interface ServerStatePayload {
  type: 'STATE_SYNC';
  partyToken: string;
  remoteBaseUrl: string;   // Public Cloudflare Tunnel URL for QR code generation
  isPaused: boolean;
  currentSong: QueueItem | null;
  queue: QueueItem[];
}

export interface ServerCommandPayload {
  type: 'PLAYER_COMMAND';
  command: PlaybackCommand;
}

export interface ServerPongPayload {
  type: 'PONG';
}

export type WsOutboundMessage =
  | ServerStatePayload
  | ServerCommandPayload
  | ServerPongPayload;

export type WsInboundMessage =
  | { type: 'SONG_ENDED'; id: string }
  | { type: 'PLAYER_COMMAND'; command: PlaybackCommand }
  | { type: 'PING' };
```

---

## 5. Backend Implementation Specifications (`packages/backend`)

### 5.1 Environment Variables
| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP & WebSocket listen port. |
| `PARTY_TOKEN` | Auto-generated 6-char | Static or dynamic token required by `/remote` clients. |
| `PUBLIC_REMOTE_URL` | `http://localhost:3000` | External Cloudflare Tunnel URL encoded into the TV QR code (e.g., `https://sing.example.com`). |
| `CACHE_DIR` | `/app/cache` | Persistent volume for downloaded `.mp4` files. |
| `MAX_CACHE_GB` | `25` | LRU cache eviction threshold for `/app/cache`. |

### 5.2 Media Service (`packages/backend/src/ytdlp.ts`)
Must use `node:child_process` (`execFile`) with strict argument arrays to prevent shell injection.

```typescript
// packages/backend/src/ytdlp.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { SearchResult } from '@singpulse/shared/types';

const execFileAsync = promisify(execFile);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const MAX_CACHE_BYTES = Number(process.env.MAX_CACHE_GB || 25) * 1024 * 1024 * 1024;

const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function validateVideoId(videoId: string): boolean {
  return YT_ID_REGEX.test(videoId);
}

export async function searchYouTubeKaraoke(query: string): Promise<SearchResult[]> {
  const sanitized = query.replace(/[^\w\s-]/gi, '').trim().slice(0, 80);
  if (!sanitized) return [];

  const { stdout } = await execFileAsync('yt-dlp', [
    `ytsearch10:${sanitized} karaoke`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-errors'
  ], { timeout: 10000 });

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const data = JSON.parse(line);
      return {
        videoId: data.id,
        title: data.title,
        duration: data.duration || 0,
        thumbnail: data.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`,
        channel: data.uploader || data.channel || 'YouTube'
      };
    })
    .filter((item) => validateVideoId(item.videoId));
}

export async function downloadKaraokeVideo(videoId: string): Promise<string> {
  if (!validateVideoId(videoId)) {
    throw new Error('Invalid YouTube Video ID');
  }

  const outputPath = path.join(CACHE_DIR, `${videoId}.mp4`);
  if (existsSync(outputPath)) {
    return `/media/${videoId}.mp4`;
  }

  evictOldCacheIfNeeded();

  await execFileAsync('yt-dlp', [
    `https://www.youtube.com/watch?v=${videoId}`,
    // Enforce H.264 + AAC up to 1080p for universal hardware decoding on Android TV devices
    '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=1080][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    // Strip non-singing intros, outros, and sponsor segments automatically
    '--sponsorblock-remove', 'sponsor,intro,outro,selfpromo,interaction,music_offtopic',
    '--no-playlist',
    '--no-part',
    '-o', outputPath
  ], { timeout: 180000 });

  return `/media/${videoId}.mp4`;
}

function evictOldCacheIfNeeded(): void {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => {
        const fullPath = path.join(CACHE_DIR, f);
        const stats = statSync(fullPath);
        return { fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // Oldest first

    let totalSize = files.reduce((acc, f) => acc + f.size, 0);
    for (const file of files) {
      if (totalSize <= MAX_CACHE_BYTES) break;
      unlinkSync(file.fullPath);
      totalSize -= file.size;
    }
  } catch {
    // Ignore eviction errors on empty directory
  }
}
```

### 5.3 Queue & Pre-Fetch Engine (`packages/backend/src/queueManager.ts`)
Implements fair-rotation queueing (interleaving singers so one user cannot monopolize the queue) and concurrent background pre-fetching of upcoming tracks.

```typescript
// packages/backend/src/queueManager.ts
import { randomUUID } from 'node:crypto';
import { downloadKaraokeVideo } from './ytdlp.ts';
import type {
  QueueItem,
  ServerStatePayload,
  PlaybackCommand,
  WsOutboundMessage
} from '@singpulse/shared/types';

type BroadcastFn = (msg: WsOutboundMessage) => void;

export class QueueManager {
  private currentSong: QueueItem | null = null;
  private queue: QueueItem[] = [];
  private isPaused = false;
  private activeDownloads = new Set<string>();
  private partyToken: string;
  private remoteBaseUrl: string;
  private broadcast: BroadcastFn;

  constructor(partyToken: string, remoteBaseUrl: string, broadcast: BroadcastFn) {
    this.partyToken = partyToken;
    this.remoteBaseUrl = remoteBaseUrl;
    this.broadcast = broadcast;
  }

  public getState(): ServerStatePayload {
    return {
      type: 'STATE_SYNC',
      partyToken: this.partyToken,
      remoteBaseUrl: this.remoteBaseUrl,
      isPaused: this.isPaused,
      currentSong: this.currentSong,
      queue: this.queue
    };
  }

  public enqueue(item: Omit<QueueItem, 'id' | 'status'>): QueueItem {
    const newItem: QueueItem = {
      ...item,
      id: randomUUID(),
      status: 'queued'
    };

    this.insertWithFairRotation(newItem);
    this.sync();
    void this.processQueue();
    return newItem;
  }

  // Fair rotation: ensures everyone sings once in round-robin order
  private insertWithFairRotation(newItem: QueueItem): void {
    const singerKey = newItem.singer.trim().toLowerCase();
    const existingCount = this.queue.filter(
      (q) => q.singer.trim().toLowerCase() === singerKey
    ).length;

    if (existingCount === 0) {
      const seenSingers = new Set<string>();
      for (let i = 0; i < this.queue.length; i++) {
        const s = this.queue[i].singer.trim().toLowerCase();
        if (seenSingers.has(s)) {
          this.queue.splice(i, 0, newItem);
          return;
        }
        seenSingers.add(s);
      }
    }
    this.queue.push(newItem);
  }

  public remove(id: string): void {
    this.queue = this.queue.filter((item) => item.id !== id);
    this.sync();
    void this.processQueue();
  }

  public skipCurrent(): void {
    this.currentSong = null;
    this.isPaused = false;
    this.advancePlayback();
  }

  public handleSongEnded(id: string): void {
    if (this.currentSong && this.currentSong.id === id) {
      this.currentSong = null;
      this.isPaused = false;
      this.advancePlayback();
    }
  }

  public sendCommand(command: PlaybackCommand): void {
    if (command.action === 'toggle_pause') {
      this.isPaused = !this.isPaused;
      this.sync();
    } else if (command.action === 'skip') {
      this.skipCurrent();
      return;
    }
    this.broadcast({ type: 'PLAYER_COMMAND', command });
  }

  private advancePlayback(): void {
    if (this.currentSong !== null) return;

    const nextReadyIdx = this.queue.findIndex((q) => q.status === 'ready');
    if (nextReadyIdx !== -1) {
      const [nextSong] = this.queue.splice(nextReadyIdx, 1);
      nextSong.status = 'playing';
      this.currentSong = nextSong;
      this.isPaused = false;
    }
    this.sync();
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    // Pre-fetch up to the first 3 queued songs concurrently
    const candidates = this.queue
      .filter((q) => q.status === 'queued')
      .slice(0, 3);

    for (const item of candidates) {
      if (this.activeDownloads.has(item.id)) continue;
      this.activeDownloads.add(item.id);
      item.status = 'downloading';
      this.sync();

      downloadKaraokeVideo(item.videoId)
        .then((mediaUrl) => {
          item.mediaUrl = mediaUrl;
          item.status = 'ready';
          this.activeDownloads.delete(item.id);
          if (!this.currentSong) {
            this.advancePlayback();
          } else {
            this.sync();
          }
        })
        .catch((err: unknown) => {
          item.status = 'error';
          item.errorMessage = err instanceof Error ? err.message : 'Download failed';
          this.activeDownloads.delete(item.id);
          this.sync();
        });
    }
  }

  private sync(): void {
    this.broadcast(this.getState());
  }
}
```

### 5.4 Fastify Server & Security Middleware (`packages/backend/src/server.ts`)
* **LAN vs. Cloudflare Tunnel Security Model:** Requests coming from private RFC1918 LAN subnets (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, `127.0.0.1`) WITHOUT a `cf-connecting-ip` header are trusted (so the Android TV receiver can connect cleanly without a token). Requests arriving via the Cloudflare Tunnel (which carry `cf-connecting-ip`) or external networks MUST supply `?token=<PARTY_TOKEN>` or `x-party-token: <PARTY_TOKEN>`.

```typescript
// packages/backend/src/server.ts
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { QueueManager } from './queueManager.ts';
import { searchYouTubeKaraoke } from './ytdlp.ts';
import type { WsInboundMessage, WsOutboundMessage } from '@singpulse/shared/types';
import type { WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.resolve(import.meta.dirname, '../../frontend/dist');
const PARTY_TOKEN = process.env.PARTY_TOKEN || randomBytes(3).toString('hex');
const PUBLIC_REMOTE_URL = process.env.PUBLIC_REMOTE_URL || `http://localhost:${PORT}`;

mkdirSync(CACHE_DIR, { recursive: true });

const app = Fastify({ logger: true });
await app.register(fastifyCors, { origin: true });
await app.register(fastifyWebsocket);

const clients = new Set<WebSocket>();

function broadcast(msg: WsOutboundMessage): void {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

const queueManager = new QueueManager(PARTY_TOKEN, PUBLIC_REMOTE_URL, broadcast);

function isTrustedLanRequest(ip: string, headers: Record<string, unknown>): boolean {
  if (headers['cf-connecting-ip']) return false;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|::ffff:192\.168\.|::1)/.test(ip);
}

function isAuthorized(req: { ip: string; headers: Record<string, unknown>; query: Record<string, unknown> }): boolean {
  const token = (req.query?.token as string) || (req.headers['x-party-token'] as string);
  if (token === PARTY_TOKEN) return true;
  return isTrustedLanRequest(req.ip, req.headers);
}

// 1. Serve cached MP4 karaoke files with HTTP Range support
await app.register(fastifyStatic, {
  root: CACHE_DIR,
  prefix: '/media/',
  decorateReply: false,
  acceptRanges: true
});

// 2. Serve Vue 3 SPA static files
await app.register(fastifyStatic, {
  root: FRONTEND_DIST,
  prefix: '/'
});

// 3. WebSocket Endpoint
app.get('/ws', { websocket: true }, (socket, req) => {
  if (!isAuthorized({ ip: req.ip, headers: req.headers, query: req.query as Record<string, unknown> })) {
    socket.close(4001, 'Unauthorized Party Token');
    return;
  }

  clients.add(socket);
  socket.send(JSON.stringify(queueManager.getState()));

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsInboundMessage;
      if (msg.type === 'SONG_ENDED') {
        queueManager.handleSongEnded(msg.id);
      } else if (msg.type === 'PLAYER_COMMAND') {
        queueManager.sendCommand(msg.command);
      } else if (msg.type === 'PING') {
        const pong: WsOutboundMessage = { type: 'PONG' };
        socket.send(JSON.stringify(pong));
      }
    } catch {
      // Ignore malformed payloads
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });
});

// 4. REST API Endpoints
app.get('/api/search', async (req, reply) => {
  if (!isAuthorized({ ip: req.ip, headers: req.headers, query: req.query as Record<string, unknown> })) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { q } = req.query as { q?: string };
  if (!q) return [];
  return searchYouTubeKaraoke(q);
});

app.post('/api/queue', async (req, reply) => {
  if (!isAuthorized({ ip: req.ip, headers: req.headers, query: req.query as Record<string, unknown> })) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const body = req.body as { videoId: string; title: string; singer: string; duration: number; thumbnail: string };
  if (!body?.videoId || !body?.singer) {
    return reply.code(400).send({ error: 'Missing videoId or singer name' });
  }
  return queueManager.enqueue(body);
});

app.delete('/api/queue/:id', async (req, reply) => {
  if (!isAuthorized({ ip: req.ip, headers: req.headers, query: req.query as Record<string, unknown> })) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { id } = req.params as { id: string };
  queueManager.remove(id);
  return { ok: true };
});

// SPA Fallback for Vue Router (/tv and /remote)
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/media')) {
    reply.code(404).send({ error: 'Not Found' });
    return;
  }
  return reply.sendFile('index.html');
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`SingPulse Server Active | Party Token: ${PARTY_TOKEN}`);
```

---

## 6. Frontend, Design System & Capacitor TV Specifications (`packages/frontend`)

### 6.1 Vite 8 & Tailwind CSS v4 Configuration
* **`packages/frontend/vite.config.ts`:**
```typescript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/media': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
});
```

* **`packages/frontend/src/style.css` (Tailwind v4 CSS-first Theme):**
Do **NOT** use Tailwind v3 `tailwind.config.js` or legacy v3 utilities (e.g., use `bg-linear-to-br` or custom CSS variables instead of `bg-gradient-to-br`). Define the custom design tokens directly via `@theme`:
```css
@import "tailwindcss";

@theme {
  --font-display: "Syne", "Space Grotesk", sans-serif;
  --font-sans: "Plus Jakarta Sans", "Inter", sans-serif;
  --font-mono: "JetBrains Mono", monospace;

  --color-obsidian: #070709;
  --color-surface: #111116;
  --color-surface-elevated: #1a1a22;
  --color-neon-coral: #ff2a5f;
  --color-acid-lime: #c8ff00;
  --color-vinyl-amber: #ff9e00;
}
```
*(Include the Google Fonts `<link>` for `Syne`, `Plus Jakarta Sans`, and `JetBrains Mono` in `packages/frontend/index.html`.)*

### 6.2 Aesthetic Direction & Anti-Slop UI Guidelines
The coding agent has creative freedom over exact component markup, animations, and micro-interactions in `TvPlayerView.vue` and `MobileRemoteView.vue`, provided it strictly adheres to the **"Tokyo Late-Night Vinyl Lounge / Teenage Engineering"** design language:

* **STRICT ANTI-SLOP BANS:**
  * **NO Emojis Anywhere in the UI:** Never use `🎤`, `🎵`, or `🔥`. Use crisp geometric vectors from `lucide-vue-next` (`MicVocal`, `Disc3`, `Radio`, `SkipForward`, `Pause`, `Play`, `Trash2`) or custom inline SVGs (such as animated equalizer bars).
  * **NO Stock SaaS Gradients or Slate Cards:** Never use generic indigo/purple/slate gradients (`from-slate-950 via-indigo-950`) or default SaaS dashboard cards.
* **Visual Language & Layout:**
  * **Palette:** Deep OLED-friendly `--color-obsidian` (`#070709`) backgrounds paired with razor-sharp `1px` architectural borders (`border-white/12`), tactile dark matte surfaces (`--color-surface`), and high-contrast `--color-acid-lime` (`#c8ff00`) and `--color-neon-coral` (`#ff2a5f`) accents.
  * **Typography:** Oversized editorial display headers (`font-display uppercase tracking-tighter`) paired with technical monospace metadata (`font-mono text-xs tracking-widest uppercase`) for timecodes, room tokens, queue indices (`01`, `02`), and download statuses.

### 6.3 Resilient Pinia WebSocket Store (`packages/frontend/src/stores/karaoke.ts`)
Must maintain a silent heartbeat every 15 seconds, handle `PONG` responses cleanly, and reconnect automatically on disconnect without rendering intrusive connection-lost modals.

```typescript
// packages/frontend/src/stores/karaoke.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  QueueItem,
  SearchResult,
  PlaybackCommand,
  WsOutboundMessage
} from '@singpulse/shared/types';

export const useKaraokeStore = defineStore('karaoke', () => {
  const partyToken = ref<string>(new URLSearchParams(window.location.search).get('token') || '');
  const remoteBaseUrl = ref<string>(window.location.origin);
  const currentSong = ref<QueueItem | null>(null);
  const queue = ref<QueueItem[]>([]);
  const isPaused = ref<boolean>(false);
  const connected = ref<boolean>(false);

  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let onCommandCallback: ((cmd: PlaybackCommand) => void) | null = null;

  const qrJoinUrl = computed(() => {
    return `${remoteBaseUrl.value}/remote?token=${partyToken.value}`;
  });

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(partyToken.value)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connected.value = true;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PING' }));
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as WsOutboundMessage;
      if (data.type === 'PONG') return;
      if (data.type === 'STATE_SYNC') {
        partyToken.value = data.partyToken;
        remoteBaseUrl.value = data.remoteBaseUrl;
        currentSong.value = data.currentSong;
        queue.value = data.queue;
        isPaused.value = data.isPaused;
      } else if (data.type === 'PLAYER_COMMAND' && onCommandCallback) {
        onCommandCallback(data.command);
      }
    };

    ws.onclose = () => {
      connected.value = false;
      if (pingTimer) clearInterval(pingTimer);
      setTimeout(connect, 2000);
    };
  }

  function notifySongEnded(id: string) {
    ws?.send(JSON.stringify({ type: 'SONG_ENDED', id }));
  }

  function sendCommand(command: PlaybackCommand) {
    ws?.send(JSON.stringify({ type: 'PLAYER_COMMAND', command }));
  }

  function registerCommandHandler(cb: (cmd: PlaybackCommand) => void) {
    onCommandCallback = cb;
  }

  async function searchSongs(query: string): Promise<SearchResult[]> {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'x-party-token': partyToken.value }
    });
    if (!res.ok) throw new Error('Search failed');
    return res.json();
  }

  async function enqueueSong(song: SearchResult, singer: string) {
    await fetch('/api/queue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-party-token': partyToken.value
      },
      body: JSON.stringify({ ...song, singer })
    });
  }

  async function removeQueueItem(id: string) {
    await fetch(`/api/queue/${id}`, {
      method: 'DELETE',
      headers: { 'x-party-token': partyToken.value }
    });
  }

  return {
    partyToken,
    qrJoinUrl,
    currentSong,
    queue,
    isPaused,
    connected,
    connect,
    notifySongEnded,
    sendCommand,
    registerCommandHandler,
    searchSongs,
    enqueueSong,
    removeQueueItem
  };
});
```

### 6.4 Functional & Design Requirements for Views

#### 1. `TvPlayerView.vue` (10-Foot Android TV Interface)
* **Idle Stage Screen (No Active Video):**
  * Asymmetric split-screen architectural layout on `--color-obsidian` with subtle grid lines or radial vinyl groove motifs.
  * Left side: Bold typographic branding (`SINGPULSE // STAGE RECEIVER`), live connection status indicator (`ONLINE // TOKEN: <PARTY_TOKEN>`), and a live "UPCOMING SETLIST" ticker showing the first 4 queued tracks with monospace index numbers (`01`, `02`), singer names, and animated segmented status bars (`BUFFERING STREAM` vs `READY`).
  * Right side: High-contrast ticket-stub or hardware-module card framing `<QrcodeVue :value="store.qrJoinUrl" :size="260" level="M" />` with step-by-step monospace instructions to scan and queue tracks.
* **Active Playback Mode (`v-if="store.currentSong?.mediaUrl"`):**
  * Fullscreen `<video>` element (`autoplay`, `playsinline`, `@ended="store.notifySongEnded(store.currentSong.id)"`, `@error="store.notifySongEnded(store.currentSong.id)"`).
  * Broadcast-style compact HUD overlay in the top-right corner (`bg-obsidian/85 backdrop-blur-md border border-white/15`): displays an animated SVG equalizer badge, current singer name in `--color-acid-lime`, "NEXT MIC" singer preview, and a compact `72px` QR code so late-arriving guests can join mid-song.
* **Android TV Remote Keybindings (`window.addEventListener('keydown', ...)`):**
  * `Enter` / `MediaPlayPause` / ` ` (Space) $\rightarrow$ `store.sendCommand({ action: 'toggle_pause' })`
  * `MediaTrackNext` / `ArrowRight` $\rightarrow$ `store.sendCommand({ action: 'skip' })`
  * `ArrowLeft` $\rightarrow$ `store.sendCommand({ action: 'restart' })`
  * Register command handler via `store.registerCommandHandler` to imperatively call `.play()`, `.pause()`, or `currentTime = 0` on the `<video>` element, and watch `store.currentSong?.id` to call `.load()` and `.play()` on track transitions.

#### 2. `MobileRemoteView.vue` (Handheld Guest Controller)
* **Aesthetic:** Looks and feels like a physical pocket synthesizer / studio remote controller (`--color-obsidian` background, tactile pill/square buttons with active press states, monospace status readouts).
* **Persistent Singer Identity:** Top bar displays current guest handle stored in `localStorage.getItem('singpulse_singer_name')` with an inline edit toggle. Prompts the guest to enter their stage name before queuing their first track.
* **Search & Instant Queue:** Debounced (`350ms`) search bar querying `store.searchSongs(q)`. Results display thumbnail, cleaned title, formatted duration (`MM:SS` in `font-mono`), and a 1-tap `QUEUE` button that transitions to an `--color-acid-lime` confirmation state (`QUEUED`).
* **Live Deck & Queue Drawer:** Sticky bottom transport bar and expandable queue sheet showing the currently playing track, hardware-inspired transport buttons (`Play/Pause`, `Restart`, `Skip`), and the fair-rotation upcoming queue with live download badges (`QUEUED`, `FETCHING`, `LOCKED IN`) and ability to remove tracks.

### 6.5 Capacitor Configuration & Android TV Overrides
In `packages/frontend/capacitor.config.ts`, read `CAP_SERVER_URL` from environment variables at build time so CI/CD can bake in the server's LAN IP (`http://192.168.1.100:3000/tv`).

```typescript
// packages/frontend/capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const serverUrl = process.env.CAP_SERVER_URL || 'http://192.168.1.100:3000/tv';

const config: CapacitorConfig = {
  appId: 'app.singpulse.tv',
  appName: 'SingPulse TV',
  webDir: 'dist',
  server: {
    url: serverUrl,
    cleartext: true
  }
};

export default config;
```

#### `packages/frontend/android-tv-template/AndroidManifest.xml`
Overwrites `android/app/src/main/AndroidManifest.xml` during the Capacitor build to register the Android TV Leanback banner and enable local HTTP cleartext traffic:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <uses-feature
        android:name="android.software.leanback"
        android:required="false" />
    <uses-feature
        android:name="android.hardware.touchscreen"
        android:required="false" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:banner="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:screenOrientation="landscape"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

#### `packages/frontend/android-tv-template/MainActivity.java`
Overwrites `android/app/src/main/java/app/singpulse/tv/MainActivity.java` to disable the user-gesture autoplay lock and keep the Android TV screen awake:

```java
package app.singpulse.tv;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Prevent Android TV screensaver / sleep mode during parties
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Allow unmuted HTML5 <video> autoplay without clicking the remote
        WebSettings webSettings = this.bridge.getWebView().getSettings();
        webSettings.setMediaPlaybackRequiresUserGesture(false);
    }
}
```

---

## 7. Multi-Stage Dockerfile & Compose Stack

### 7.1 `Dockerfile`
```dockerfile
# Stage 1: Build Vue 3 Frontend with Vite 8 (Rolldown/Oxc)
FROM node:24-bookworm-slim AS frontend-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /build

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/frontend/package.json ./packages/frontend/
RUN pnpm install --frozen-lockfile=false

COPY packages/shared ./packages/shared
COPY packages/frontend ./packages/frontend
RUN pnpm --filter @singpulse/frontend build

# Stage 2: Lean Production Runtime (Node 24 Native TS + yt-dlp + ffmpeg)
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production

# Install ffmpeg, python3 (for yt-dlp), and standalone yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
RUN pnpm install --prod --frozen-lockfile=false

COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend
COPY --from=frontend-builder /build/packages/frontend/dist ./packages/frontend/dist

ENV PORT=3000
ENV CACHE_DIR=/app/cache
ENV FRONTEND_DIST=/app/packages/frontend/dist

EXPOSE 3000
CMD ["node", "packages/backend/src/server.ts"]
```

### 7.2 `docker-compose.yml` (Production Stack)
Includes **Watchtower** so whenever GitHub Actions builds a new Docker image, your server automatically pulls and restarts the container.

```yaml
services:
  singpulse:
    image: ghcr.io/${GITHUB_REPOSITORY:-owner/singpulse}:latest
    container_name: singpulse
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - PARTY_TOKEN=${PARTY_TOKEN:-pulse26}
      - PUBLIC_REMOTE_URL=${PUBLIC_REMOTE_URL:-https://sing.yourdomain.com}
      - MAX_CACHE_GB=25
    volumes:
      - ./singpulse-cache:/app/cache
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

  # Automatically updates singpulse when CI pushes a new image to GHCR
  watchtower:
    image: containrrr/watchtower:latest
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 300 --cleanup --label-enable
```

---

## 8. Automated CI/CD Pipelines (`.github/workflows/`)

### 8.1 Automatic Server Docker Build (`.github/workflows/docker-publish.yml`)
Automatically runs `oxlint`, builds the multi-stage Docker container, and pushes it to GitHub Container Registry (`ghcr.io`) on every push to `main`, plus a weekly cron schedule to ensure the bundled `yt-dlp` binary stays updated against YouTube changes.

```yaml
name: Build & Publish SingPulse Server Image

on:
  push:
    branches: [main]
  schedule:
    # Rebuild weekly on Sundays at 03:00 UTC to pull the latest yt-dlp release
    - cron: '0 3 * * 0'
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup pnpm & Node 24
        uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'

      - name: Install dependencies & run Oxlint
        run: |
          pnpm install
          pnpm dlx oxlint

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=raw,value=latest
            type=sha

      - name: Build and push Docker image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
```

### 8.2 Automatic Capacitor Android TV APK Build (`.github/workflows/android-tv-apk.yml`)
Compiles the Capacitor Android TV APK in the cloud (so Android Studio never needs to be installed locally) and uploads `singpulse-tv-apk` to workflow artifacts.

```yaml
name: Build SingPulse Android TV APK

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      server_lan_url:
        description: 'Server LAN URL for Android TV Receiver (e.g., http://192.168.1.100:3000/tv)'
        required: true
        default: 'http://192.168.1.100:3000/tv'

permissions:
  contents: write

jobs:
  build-apk:
    runs-on: ubuntu-latest
    env:
      CAP_SERVER_URL: ${{ github.event.inputs.server_lan_url || vars.CAP_SERVER_URL || 'http://192.168.1.100:3000/tv' }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup pnpm & Node 24
        uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'

      - name: Set up JDK 21 for Android Gradle Plugin
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: Build Frontend & Initialize Capacitor Android
        run: |
          pnpm install
          pnpm --filter @singpulse/frontend build
          cd packages/frontend
          if [ ! -d "android" ]; then
            npx cap add android
          fi
          npx cap sync android
          # Apply Android TV Leanback & Autoplay Overrides
          mkdir -p android/app/src/main/java/app/singpulse/tv
          cp android-tv-template/AndroidManifest.xml android/app/src/main/AndroidManifest.xml
          cp android-tv-template/MainActivity.java android/app/src/main/java/app/singpulse/tv/MainActivity.java

      - name: Compile Android TV APK via Gradle
        working-directory: packages/frontend/android
        run: |
          chmod +x gradlew
          ./gradlew assembleDebug

      - name: Upload SingPulse TV APK Artifact
        uses: actions/upload-artifact@v4
        with:
          name: singpulse-tv-apk
          path: packages/frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 9. Agent Step-by-Step Execution Checklist

When instructing an AI coding agent to implement this specification, the agent must execute in this exact sequence:

1. **Initialize Workspace:** Create root `package.json`, `pnpm-workspace.yaml`, and `@singpulse/shared` (with `"exports": { "./types": "./src/types.ts" }`), `@singpulse/backend` (including `@types/ws` and `@types/node`), and `@singpulse/frontend` (including `lucide-vue-next`, `qrcode.vue`, `@tailwindcss/vite`) manifests.
2. **Implement Shared Types:** Create `packages/shared/src/types.ts` including `ServerPongPayload` in `WsOutboundMessage`.
3. **Implement Backend:** Create `ytdlp.ts`, `queueManager.ts`, and `server.ts`. Verify native Node 24 TypeScript execution with `node --check packages/backend/src/server.ts`.
4. **Implement Frontend & Design System:** Configure Tailwind CSS v4 `@theme` tokens in `style.css` and Google Fonts in `index.html`. Implement `TvPlayerView.vue` and `MobileRemoteView.vue` following the "Tokyo Late-Night Vinyl Lounge / Teenage Engineering" aesthetic direction (zero emojis, zero legacy Tailwind v3 gradients). Run `pnpm --filter @singpulse/frontend build` to verify zero bundle errors.
5. **Create Capacitor TV Overrides:** Populate `capacitor.config.ts` and `packages/frontend/android-tv-template/` with `AndroidManifest.xml` and `MainActivity.java`.
6. **Create DevOps & CI/CD Files:** Generate `Dockerfile`, `docker-compose.yml`, `.github/workflows/docker-publish.yml`, and `.github/workflows/android-tv-apk.yml`.
7. **Final Verification:** Run `pnpm dlx oxlint` and `pnpm dlx @typescript/native-preview` (`tsgo --noEmit`) across all packages to confirm 100% type and lint compliance.