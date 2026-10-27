// packages/backend/src/server.ts
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { QueueManager } from './queueManager.ts';
import { searchYouTubeKaraoke } from './ytdlp.ts';
import type { PlaybackCommand, QueueItem, WsInboundMessage, WsOutboundMessage } from '@singpulse/shared/types';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.resolve(import.meta.dirname, '../../frontend/dist');
const PARTY_TOKEN = process.env.PARTY_TOKEN || randomBytes(3).toString('hex');
const PUBLIC_REMOTE_URL = process.env.PUBLIC_REMOTE_URL || `http://localhost:${PORT}`;

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

const PARTY_TOKEN_DIGEST = digest(PARTY_TOKEN);

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

  const candidate = msg as { type?: unknown; id?: unknown; command?: unknown };
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

  clients.add(socket);
  socket.send(JSON.stringify(queueManager.getState()));

  socket.on('message', (raw) => {
    const msg = parseInboundMessage(raw.toString());
    if (!msg) return; // Ignore malformed payloads

    if (msg.type === 'SONG_ENDED') {
      queueManager.handleSongEnded(msg.id);
    } else if (msg.type === 'PLAYER_COMMAND') {
      queueManager.sendCommand(msg.command);
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
// oxlint-disable-next-line no-console -- deliberate one-time token readout for the host operator (spec §5.4)
console.log(`SingPulse Server Active | Party Token: ${PARTY_TOKEN}`);
