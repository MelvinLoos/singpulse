// packages/backend/src/server.ts
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { QueueManager } from './queueManager.ts';
import { PolaroidStore } from './polaroidStore.ts';
import type { PolaroidImageExt } from './polaroidStore.ts';
import { cacheStats, searchYouTubeKaraoke } from './ytdlp.ts';
import type { CacheStats } from './ytdlp.ts';
import type {
  AdminFairQueueRequest,
  AdminReorderRequest,
  AdminRotateTokenResponse,
  AdminUpdateQueueItemRequest,
  PlaybackCommand,
  QueueItem,
  ServerStatePayload,
  StatsPayload,
  SubmitPolaroidRequest,
  VoteSuperlative,
  WsInboundMessage,
  WsOutboundMessage
} from '@singpulse/shared/types';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.resolve(import.meta.dirname, '../../frontend/dist');
// Mutable: the host can rotate the token at runtime (POST /api/admin/rotate-token)
let PARTY_TOKEN = process.env.PARTY_TOKEN || randomBytes(3).toString('hex');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PARTY_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PARTY_TOKEN_LENGTH = 6;
const WS_CLOSE_TOKEN_ROTATED = 4001;
const MAX_BAD_PINS = 10;
// Ceiling across all clients: the per-client key can be rotated by anyone who can forge cf-connecting-ip
const MAX_BAD_PINS_GLOBAL = 50;
const PUBLIC_REMOTE_URL = process.env.PUBLIC_REMOTE_URL || `http://localhost:${PORT}`;
// Optional key for GET /api/stats (dashboards). Unset = LAN only.
const STATS_API_KEY = process.env.STATS_API_KEY || '';
// Dashboards poll every ~10 s; re-listing the cache directory that often is wasted work
const STATS_CACHE_TTL_MS = 30 * 1000;

const VOTE_SUPERLATIVES: ReadonlySet<string> = new Set<VoteSuperlative>(['GRAMMY_WORTHY', 'PURE_PASSION', 'STAGE_LEGEND', 'RIP_EARS']);

// Polaroid uploads: phones send a ~50 KB canvas JPEG; anything larger is refused
const POLAROID_MAX_DATA_URL = 350 * 1024;
const POLAROID_BODY_LIMIT = 500 * 1024;
const POLAROID_COOLDOWN_MS = 15 * 1000;
const POLAROID_PREFIXES: ReadonlyArray<{ prefix: string; ext: PolaroidImageExt }> = [
  { prefix: 'data:image/jpeg;base64,', ext: 'jpg' },
  { prefix: 'data:image/webp;base64,', ext: 'webp' }
];
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const PLAYBACK_ACTIONS: ReadonlySet<string> = new Set<PlaybackCommand['action']>(['toggle_pause', 'skip', 'restart', 'volume']);

// The 6-char party token (spec §5.1) is short, so cap how many distinct wrong
// guesses one client may make. Repeating the same stale token never locks out.
const MAX_DISTINCT_BAD_TOKENS = 20;
const BAD_TOKEN_WINDOW_MS = 15 * 60 * 1000;
const PRIVATE_IP_REGEX = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|::ffff:192\.168\.|::1)/;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const PUBLIC_ORIGIN = originOf(PUBLIC_REMOTE_URL);

mkdirSync(CACHE_DIR, { recursive: true });

const app = Fastify({
  logger: {
    serializers: {
      // Never write party tokens from ?token= query strings to the logs
      req: (req) => ({
        method: req.method,
        url: req.url.replace(/([?&]token=)[^&]*/gi, '$1[redacted]'),
        remoteAddress: req.ip
      })
    }
  }
});
// Browsers send Origin on cross-site requests and on every WebSocket handshake
// (which CORS does not cover). Only pages served by this host or the public
// tunnel origin may talk to the API; otherwise any site a LAN guest visits
// could ride on the guest's trusted LAN address.
function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // Non-browser clients
  const parsed = originOf(origin);
  if (!parsed) return false;
  return new URL(parsed).host === host || parsed === PUBLIC_ORIGIN;
}

app.addHook('onRequest', async (req, reply) => {
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
    return reply.code(403).send({ error: 'Origin not allowed' });
  }
});

await app.register(fastifyCors, {
  delegator: (req, callback) => callback(null, { origin: isAllowedOrigin(req.headers.origin, req.headers.host) })
});
await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });

// `tv` marks the stage receiver: the only client that is told the live party token
const clients = new Map<WebSocket, { tv: boolean }>();

function withoutToken(state: ServerStatePayload): ServerStatePayload {
  const { partyToken: _token, ...rest } = state;
  return rest;
}

function messageFor(msg: WsOutboundMessage, tv: boolean): string {
  return JSON.stringify(msg.type === 'STATE_SYNC' && !tv ? withoutToken(msg) : msg);
}

function broadcast(msg: WsOutboundMessage): void {
  const forTv = messageFor(msg, true);
  const forGuests = messageFor(msg, false);
  for (const [client, { tv }] of clients) {
    if (client.readyState === 1) {
      client.send(tv ? forTv : forGuests);
    }
  }
}

const polaroidStore = new PolaroidStore(path.join(CACHE_DIR, 'polaroids'));
await polaroidStore.load();
const queueManager = new QueueManager(PARTY_TOKEN, PUBLIC_REMOTE_URL, broadcast, () => polaroidStore.latest());

function isTrustedLanRequest(ip: string, headers: Record<string, unknown>): boolean {
  if (headers['cf-connecting-ip']) return false;
  return PRIVATE_IP_REGEX.test(ip);
}

const badTokenAttempts = new Map<string, { tokens: Set<string>; expiresAt: number }>();

// Tunnel traffic arrives from a local cloudflared, so the real client is in
// cf-connecting-ip; only believe that header when the peer itself is private.
function clientKey(ip: string, headers: Record<string, unknown>): string {
  const forwarded = headers['cf-connecting-ip'];
  return typeof forwarded === 'string' && forwarded && PRIVATE_IP_REGEX.test(ip) ? forwarded : ip;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

let PARTY_TOKEN_DIGEST = digest(PARTY_TOKEN);
const ADMIN_PIN_DIGEST = digest(ADMIN_PIN);
const STATS_API_KEY_DIGEST = STATS_API_KEY ? digest(STATS_API_KEY) : null;

function isAuthorized(req: { ip: string; headers: Record<string, unknown>; query: Record<string, unknown> }): boolean {
  if (isTrustedLanRequest(req.ip, req.headers)) return true;

  const token = (req.query?.token as string) || (req.headers['x-party-token'] as string);
  if (typeof token !== 'string' || !token) return false;

  const key = clientKey(req.ip, req.headers);
  const now = Date.now();
  let attempts = badTokenAttempts.get(key);
  if (attempts && attempts.expiresAt <= now) {
    badTokenAttempts.delete(key);
    attempts = undefined;
  }
  if (attempts && attempts.tokens.size >= MAX_DISTINCT_BAD_TOKENS) return false;

  if (timingSafeEqual(digest(token), PARTY_TOKEN_DIGEST)) return true;

  if (!attempts) {
    attempts = { tokens: new Set(), expiresAt: now + BAD_TOKEN_WINDOW_MS };
    badTokenAttempts.set(key, attempts);
  }
  attempts.tokens.add(digest(token).toString('hex'));
  return false;
}

// Forget expired lockout windows so the map cannot grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [key, attempts] of badTokenAttempts) {
    if (attempts.expiresAt <= now) badTokenAttempts.delete(key);
  }
}, BAD_TOKEN_WINDOW_MS).unref();

function isAuthorizedRequest(req: FastifyRequest): boolean {
  return isAuthorized({ ip: req.ip, headers: req.headers, query: req.query as Record<string, unknown> });
}

// Untrusted socket input: accept only well-formed messages of a known type.
function parseInboundMessage(raw: string): WsInboundMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;

  const candidate = msg as {
    type?: unknown; id?: unknown; command?: unknown;
    songId?: unknown; voterId?: unknown; stars?: unknown; superlative?: unknown;
  };
  switch (candidate.type) {
    case 'PING':
      return { type: 'PING' };
    case 'SONG_ENDED':
      return typeof candidate.id === 'string' ? { type: 'SONG_ENDED', id: candidate.id } : null;
    case 'PLAYER_COMMAND': {
      const command = candidate.command as { action?: unknown; value?: unknown } | null;
      if (typeof command?.action !== 'string' || !PLAYBACK_ACTIONS.has(command.action)) return null;
      const value = typeof command.value === 'number' && Number.isFinite(command.value) ? command.value : undefined;
      return {
        type: 'PLAYER_COMMAND',
        command: { action: command.action as PlaybackCommand['action'], ...(value === undefined ? {} : { value }) }
      };
    }
    case 'SUBMIT_VOTE': {
      const { songId, voterId, stars, superlative } = candidate;
      if (typeof songId !== 'string' || songId.length > 64) return null;
      if (typeof voterId !== 'string' || voterId.length < 8 || voterId.length > 64) return null;
      if (typeof stars !== 'number' || !Number.isInteger(stars)) return null;
      if (superlative !== undefined && (typeof superlative !== 'string' || !VOTE_SUPERLATIVES.has(superlative))) return null;
      return {
        type: 'SUBMIT_VOTE',
        songId,
        voterId,
        stars,
        ...(superlative === undefined ? {} : { superlative: superlative as VoteSuperlative })
      };
    }
    case 'SKIP_VOTE':
      return { type: 'SKIP_VOTE' };
    default:
      return null;
  }
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
  if (!isAuthorizedRequest(req)) {
    socket.close(4001, 'Unauthorized Party Token');
    return;
  }

  // Only a LAN receiver may claim the TV role; remote guests must hold the token anyway
  const tv = (req.query as { role?: unknown }).role === 'tv' && isTrustedLanRequest(req.ip, req.headers);
  clients.set(socket, { tv });
  socket.send(messageFor(queueManager.getState(), tv));

  socket.on('message', (raw) => {
    const msg = parseInboundMessage(raw.toString());
    if (!msg) return; // Ignore malformed payloads

    if (msg.type === 'SONG_ENDED') {
      queueManager.handleSongEnded(msg.id);
    } else if (msg.type === 'PLAYER_COMMAND') {
      queueManager.sendCommand(msg.command);
    } else if (msg.type === 'SUBMIT_VOTE') {
      queueManager.submitVote(msg.voterId, msg.songId, msg.stars, msg.superlative);
    } else if (msg.type === 'SKIP_VOTE') {
      if (tv) queueManager.skipVote(); // Only the stage receiver may cut the intermission short
    } else if (msg.type === 'PING') {
      const pong: WsOutboundMessage = { type: 'PONG' };
      socket.send(JSON.stringify(pong));
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });
});

// 4. REST API Endpoints
app.get('/api/health', async () => ({ ok: true }));

function isStatsAuthorized(req: FastifyRequest): boolean {
  if (!STATS_API_KEY_DIGEST) return isTrustedLanRequest(req.ip, req.headers);
  const key = req.headers['x-api-key'];
  return typeof key === 'string' && timingSafeEqual(digest(key), STATS_API_KEY_DIGEST);
}

let cachedCacheStats: { at: number; stats: CacheStats } | null = null;

function currentCacheStats(): CacheStats {
  const now = Date.now();
  if (!cachedCacheStats || now - cachedCacheStats.at > STATS_CACHE_TTL_MS) {
    cachedCacheStats = { at: now, stats: cacheStats() };
  }
  return cachedCacheStats.stats;
}

// Read-only party metrics for dashboards such as gethomepage/homepage (customapi widget)
app.get('/api/stats', async (req, reply) => {
  if (!isStatsAuthorized(req)) return reply.code(401).send({ error: 'Unauthorized' });

  let tv = 0;
  for (const client of clients.values()) if (client.tv) tv += 1;
  const cache = currentCacheStats();
  const stats: StatsPayload = {
    ...queueManager.getStats(),
    clients: { total: clients.size, tv, remotes: clients.size - tv },
    tvConnected: tv > 0,
    photos: polaroidStore.count(),
    cache: {
      ...cache,
      percent: cache.maxBytes > 0 ? Math.round((cache.bytes / cache.maxBytes) * 1000) / 10 : 0
    },
    uptime: Math.round(process.uptime())
  };
  return stats;
});

app.get('/api/search', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        q: { type: 'string', maxLength: 200 },
        token: { type: 'string' }
      }
    }
  }
}, async (req, reply) => {
  if (!isAuthorizedRequest(req)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { q } = req.query as { q?: string };
  if (!q) return [];
  try {
    return await searchYouTubeKaraoke(q);
  } catch (err) {
    req.log.error({ err }, 'yt-dlp search failed');
    return reply.code(502).send({ error: 'Search unavailable' });
  }
});

type EnqueueBody = Omit<QueueItem, 'id' | 'status'>;

app.post('/api/queue', {
  schema: {
    body: {
      type: 'object',
      required: ['videoId', 'singer'],
      additionalProperties: false,
      properties: {
        videoId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{11}$' },
        title: { type: 'string', maxLength: 300, default: 'Untitled track' },
        singer: { type: 'string', minLength: 1, maxLength: 32, pattern: '\\S' },
        duration: { type: 'number', minimum: 0, maximum: 86400, default: 0 },
        thumbnail: { type: 'string', maxLength: 2048, pattern: '^https?://', default: '' }
      }
    }
  }
}, async (req, reply) => {
  if (!isAuthorizedRequest(req)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const body = req.body as EnqueueBody;
  if (!body?.videoId || !body?.singer) {
    return reply.code(400).send({ error: 'Missing videoId or singer name' });
  }
  return queueManager.enqueue({ ...body, singer: body.singer.trim() });
});

app.delete('/api/queue/:id', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } }
    }
  }
}, async (req, reply) => {
  if (!isAuthorizedRequest(req)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const { id } = req.params as { id: string };
  queueManager.remove(id);
  return { ok: true };
});

// Polaroid photo-bomb: persisted to disk, rate limited per client
const lastPolaroidAt = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - POLAROID_COOLDOWN_MS;
  for (const [key, at] of lastPolaroidAt) {
    if (at <= cutoff) lastPolaroidAt.delete(key);
  }
}, POLAROID_COOLDOWN_MS).unref();

function hasImageMagic(buffer: Buffer, ext: PolaroidImageExt): boolean {
  if (ext === 'jpg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

app.post('/api/polaroid', {
  bodyLimit: POLAROID_BODY_LIMIT,
  schema: {
    body: {
      type: 'object',
      required: ['imageDataUrl', 'sender'],
      additionalProperties: false,
      properties: {
        imageDataUrl: { type: 'string', maxLength: POLAROID_MAX_DATA_URL },
        sender: { type: 'string', minLength: 1, maxLength: 32, pattern: '\\S' },
        caption: { type: 'string', maxLength: 24 }
      }
    }
  }
}, async (req, reply) => {
  if (!isAuthorizedRequest(req)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const body = req.body as SubmitPolaroidRequest;
  const format = POLAROID_PREFIXES.find(({ prefix }) => body.imageDataUrl.startsWith(prefix));
  if (!format) return reply.code(400).send({ error: 'Image must be a base64 JPEG or WebP' });
  const encoded = body.imageDataUrl.slice(format.prefix.length);
  if (!BASE64_REGEX.test(encoded)) return reply.code(400).send({ error: 'Invalid image data' });
  const buffer = Buffer.from(encoded, 'base64');
  if (!hasImageMagic(buffer, format.ext)) return reply.code(400).send({ error: 'Invalid image data' });

  const key = clientKey(req.ip, req.headers);
  const now = Date.now();
  const waitMs = (lastPolaroidAt.get(key) ?? 0) + POLAROID_COOLDOWN_MS - now;
  if (waitMs > 0) {
    return reply.code(429).header('retry-after', String(Math.ceil(waitMs / 1000))).send({ error: 'Slow down' });
  }
  lastPolaroidAt.set(key, now);

  const caption = body.caption?.trim();
  const item = await polaroidStore.add({
    buffer,
    ext: format.ext,
    sender: body.sender.trim(),
    ...(caption ? { caption } : {})
  });
  broadcast({ type: 'POLAROID_BURST', payload: item });
  queueManager.sync();
  return reply.code(201).send(item);
});

// 5. Host Mode (admin): party-token auth plus the host PIN on every route
const badPinAttempts = new Map<string, { count: number; expiresAt: number }>();
const globalBadPins = { count: 0, expiresAt: 0 };

function pinMatches(pin: unknown): boolean {
  return typeof pin === 'string' && pin !== '' && timingSafeEqual(digest(pin), ADMIN_PIN_DIGEST);
}

await app.register(
  async (admin) => {
    admin.addHook('preHandler', async (req, reply) => {
      if (!isAuthorizedRequest(req)) return reply.code(401).send({ error: 'Unauthorized' });

      const key = clientKey(req.ip, req.headers);
      const now = Date.now();
      let attempts = badPinAttempts.get(key);
      if (attempts && attempts.expiresAt <= now) {
        badPinAttempts.delete(key);
        attempts = undefined;
      }
      if (globalBadPins.expiresAt <= now) Object.assign(globalBadPins, { count: 0, expiresAt: now + BAD_TOKEN_WINDOW_MS });
      if (globalBadPins.count >= MAX_BAD_PINS_GLOBAL) return reply.code(429).send({ error: 'Too many attempts' });
      if (attempts && attempts.count >= MAX_BAD_PINS) return reply.code(429).send({ error: 'Too many attempts' });

      const bodyPin = (req.body as { pin?: unknown } | null | undefined)?.pin;
      if (pinMatches(req.headers['x-admin-pin'] ?? bodyPin)) {
        badPinAttempts.delete(key);
        return;
      }
      if (!attempts) {
        attempts = { count: 0, expiresAt: now + BAD_TOKEN_WINDOW_MS };
        badPinAttempts.set(key, attempts);
      }
      attempts.count += 1;
      globalBadPins.count += 1;
      return reply.code(401).send({ error: 'Invalid PIN' });
    });

    admin.post('/verify', async () => ({ ok: true }));

    admin.post('/rotate-token', async (): Promise<AdminRotateTokenResponse> => {
      let token = '';
      for (let i = 0; i < PARTY_TOKEN_LENGTH; i++) token += PARTY_TOKEN_ALPHABET[randomInt(PARTY_TOKEN_ALPHABET.length)];
      PARTY_TOKEN = token;
      PARTY_TOKEN_DIGEST = digest(token);
      badTokenAttempts.clear();
      // Broadcast first: the TV learns the new token, guests get state without it
      queueManager.setPartyToken(token);
      for (const [socket, { tv }] of clients) {
        if (!tv) socket.close(WS_CLOSE_TOKEN_ROTATED, 'PARTY_TOKEN_ROTATED');
      }
      return { partyToken: token };
    });

    admin.post('/fair-queue', {
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' }, pin: { type: 'string' } }
        }
      }
    }, (req) => {
      const { enabled } = req.body as AdminFairQueueRequest;
      queueManager.setFairQueue(enabled);
      return { ok: true, fairQueueEnabled: enabled };
    });

    admin.post('/queue/reorder', {
      schema: {
        body: {
          type: 'object',
          required: ['itemId', 'toIndex'],
          properties: {
            itemId: { type: 'string', format: 'uuid' },
            toIndex: { type: 'integer', minimum: 0, maximum: 10000 },
            pin: { type: 'string' }
          }
        }
      }
    }, async (req, reply) => {
      const { itemId, toIndex } = req.body as AdminReorderRequest;
      if (!queueManager.reorder(itemId, toIndex)) return reply.code(404).send({ error: 'Queue item not found' });
      return { ok: true };
    });

    admin.delete('/queue/:id', {
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } }
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!queueManager.remove(id)) return reply.code(404).send({ error: 'Queue item not found' });
      return { ok: true };
    });

    admin.delete('/polaroid/:id', {
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } }
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await polaroidStore.remove(id))) return reply.code(404).send({ error: 'Polaroid not found' });
      queueManager.sync();
      return { ok: true };
    });

    admin.patch('/queue/:id', {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['singer'],
          properties: { singer: { type: 'string', minLength: 1, maxLength: 32, pattern: '\\S' }, pin: { type: 'string' } }
        }
      }
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { singer } = req.body as AdminUpdateQueueItemRequest;
      if (!queueManager.updateSinger(id, singer)) return reply.code(404).send({ error: 'Queue item not found' });
      return { ok: true };
    });
  },
  { prefix: '/api/admin' }
);

// SPA Fallback for Vue Router (/tv and /remote)
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/media')) {
    reply.code(404).send({ error: 'Not Found' });
    return;
  }
  return reply.sendFile('index.html');
});

// Node runs as PID 1 in the container: handle stop signals explicitly so
// `docker stop` closes sockets cleanly instead of waiting for SIGKILL.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    app.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

await app.listen({ port: PORT, host: '0.0.0.0' });
if (ADMIN_PIN === '1234') app.log.warn('ADMIN_PIN is the default 1234. Set your own before exposing this server.');
// oxlint-disable-next-line no-console -- deliberate one-time token readout for the host operator (spec §5.4)
console.log(`SingPulse Server Active | Party Token: ${PARTY_TOKEN}`);
