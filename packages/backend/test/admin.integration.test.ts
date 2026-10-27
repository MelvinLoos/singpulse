import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { QueueItem, ServerStatePayload } from '@singpulse/shared/types';

// Boots the real server. `cf-connecting-ip` makes a loopback request look like a
// remote tunnel guest, so the party-token checks actually apply.
const PIN = '4821';
const REMOTE = { 'cf-connecting-ip': '203.0.113.9' };

let child: ChildProcess;
let base = '';
let wsBase = '';
let dir = '';
let token = 'abc123';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function api(pathname: string, init: { method?: string; pin?: string | null; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { ...REMOTE, 'x-party-token': init.token ?? token };
  if (init.pin !== null) headers['x-admin-pin'] = init.pin ?? PIN;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });
}

interface Probe {
  ws: WebSocket;
  states: ServerStatePayload[];
  closed: Promise<{ code: number; reason: string }>;
}

function openSocket(query: string, headers: Record<string, string> = {}): Promise<Probe> {
  return new Promise((resolve) => {
    // Node's WebSocket accepts undici's `headers` option
    const ws = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(`${wsBase}/ws?${query}`, { headers });
    const states: ServerStatePayload[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.addEventListener('close', (e) => res({ code: e.code, reason: e.reason }));
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as ServerStatePayload;
      if (msg.type === 'STATE_SYNC') states.push(msg);
    });
    ws.addEventListener('open', () => resolve({ ws, states, closed }));
    ws.addEventListener('close', () => resolve({ ws, states, closed }));
  });
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

async function enqueue(n: number, singer: string): Promise<QueueItem> {
  const res = await api('/api/queue', {
    method: 'POST',
    pin: null,
    body: { videoId: `vid${String(n).padStart(8, '0')}`, singer, title: `T${n}`, thumbnail: 'https://example.com/t.jpg' }
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as QueueItem;
}

describe('admin API (booted server)', () => {
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'singpulse-it-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/server.ts')], {
      env: {
        ...process.env,
        PORT: String(port),
        PARTY_TOKEN: token,
        ADMIN_PIN: PIN,
        CACHE_DIR: dir,
        FRONTEND_DIST: dir,
        PATH: '/nonexistent' // yt-dlp can never spawn: downloads fail fast, items stay queued as errors
      },
      stdio: 'ignore'
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {
        // not up yet
      }
      await settle(100);
    }
    throw new Error('server did not start');
  });

  after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects admin calls without a valid party token or PIN', async () => {
    assert.equal((await api('/api/admin/verify', { method: 'POST', token: 'wrong1' })).status, 401);
    assert.equal((await api('/api/admin/verify', { method: 'POST', pin: null })).status, 401);
    assert.equal((await api('/api/admin/verify', { method: 'POST', pin: '0000' })).status, 401);
    assert.equal((await api('/api/admin/verify', { method: 'POST' })).status, 200);
  });

  it('accepts the PIN in the request body', async () => {
    const res = await fetch(`${base}/api/admin/verify`, {
      method: 'POST',
      headers: { ...REMOTE, 'x-party-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN })
    });
    assert.equal(res.status, 200);
  });

  it('reorders, renames, vetoes and toggles fair queue', async () => {
    const a = await enqueue(1, 'Alice');
    const b = await enqueue(2, 'Bob');
    const c = await enqueue(3, 'Cleo');

    const toggle = await api('/api/admin/fair-queue', { method: 'POST', body: { enabled: false } });
    assert.deepEqual(await toggle.json(), { ok: true, fairQueueEnabled: false });

    assert.equal((await api('/api/admin/queue/reorder', { method: 'POST', body: { itemId: c.id, toIndex: 0 } })).status, 200);
    assert.equal((await api(`/api/admin/queue/${b.id}`, { method: 'PATCH', body: { singer: ' Bobby ' } })).status, 200);
    assert.equal((await api(`/api/admin/queue/${a.id}`, { method: 'DELETE' })).status, 200);

    const probe = await openSocket(`token=${token}`, REMOTE);
    await settle();
    const state = probe.states[0];
    assert.ok(state);
    assert.deepEqual(state.queue.map((q) => q.id), [c.id, b.id]);
    assert.equal(state.queue[1]?.singer, 'Bobby');
    assert.equal(state.fairQueueEnabled, false);
    probe.ws.close();

    assert.equal((await api(`/api/admin/queue/${a.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(`/api/admin/queue/${b.id}`, { method: 'PATCH', body: { singer: '   ' } })).status, 400);
    assert.equal((await api('/api/admin/queue/reorder', { method: 'POST', body: { itemId: c.id, toIndex: -1 } })).status, 400);
  });

  it('rotates the token: TV updates, guests are kicked, old token dies', async () => {
    const tv = await openSocket(`token=${token}&role=tv`);
    const guest = await openSocket(`token=${token}`, REMOTE);
    await settle();
    assert.equal(tv.states[0]?.partyToken, token, 'TV is told the token');
    assert.equal(guest.states[0]?.partyToken, undefined, 'guest never sees the token');

    const oldToken = token;
    const res = await api('/api/admin/rotate-token', { method: 'POST' });
    assert.equal(res.status, 200);
    const { partyToken } = (await res.json()) as { partyToken: string };
    assert.match(partyToken, /^[a-z0-9]{6}$/);
    assert.notEqual(partyToken, oldToken);
    token = partyToken;

    assert.deepEqual(await guest.closed, { code: 4001, reason: 'PARTY_TOKEN_ROTATED' });
    await settle();
    assert.equal(tv.ws.readyState, WebSocket.OPEN, 'TV stays connected');
    assert.equal(tv.states.at(-1)?.partyToken, partyToken, 'TV receives the new token live');
    tv.ws.close();

    assert.equal((await api('/api/admin/verify', { method: 'POST', token: oldToken })).status, 401);
    assert.equal((await api('/api/admin/verify', { method: 'POST' })).status, 200);
    const retry = await openSocket(`token=${oldToken}`, REMOTE);
    assert.equal((await retry.closed).code, 4001);
  });

  it('locks out a client after repeated wrong PINs', async () => {
    let status = 0;
    for (let i = 0; i < 12; i++) {
      status = (await api('/api/admin/verify', { method: 'POST', pin: `bad${i}` })).status;
    }
    assert.equal(status, 429);
    assert.equal((await api('/api/admin/verify', { method: 'POST' })).status, 429, 'even the right PIN waits out the window');
  });
});
