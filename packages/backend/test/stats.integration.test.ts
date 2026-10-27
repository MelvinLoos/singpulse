import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StatsPayload } from '@singpulse/shared/types';

// Boots the real server twice: with STATS_API_KEY set, and without (LAN only).
// `cf-connecting-ip` makes a loopback request look like a remote tunnel guest.
const KEY = 'test-stats-key-0123456789';
const REMOTE = { 'cf-connecting-ip': '203.0.113.9' };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

interface Booted {
  base: string;
  wsBase: string;
  stop: () => void;
}

async function boot(env: Record<string, string>, dir: string): Promise<Booted> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      PARTY_TOKEN: 'abc123',
      CACHE_DIR: dir,
      FRONTEND_DIST: dir,
      PATH: '/nonexistent', // yt-dlp can never spawn
      ...env
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, wsBase: `ws://127.0.0.1:${port}`, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await settle(100);
  }
  child.kill();
  throw new Error('server did not start');
}

describe('GET /api/stats with STATS_API_KEY', () => {
  let dir = '';
  let server: Booted;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'singpulse-stats-'));
    writeFileSync(path.join(dir, 'aaaaaaaaaaa.mp4'), Buffer.alloc(1024));
    server = await boot({ STATS_API_KEY: KEY, MAX_CACHE_GB: '1' }, dir);
  });

  after(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires the key, even from the LAN', async () => {
    assert.equal((await fetch(`${server.base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${server.base}/api/stats`, { headers: { 'x-api-key': 'wrong' } })).status, 401);
    assert.equal((await fetch(`${server.base}/api/stats`, { headers: { ...REMOTE, 'x-api-key': KEY } })).status, 200);
  });

  it('reports clients, cache and queue without leaking the party token', async () => {
    const tv = new WebSocket(`${server.wsBase}/ws?role=tv`);
    const guest = new WebSocket(`${server.wsBase}/ws`);
    await Promise.all([tv, guest].map((ws) => new Promise((resolve) => ws.addEventListener('open', resolve))));
    try {
      const res = await fetch(`${server.base}/api/stats`, { headers: { 'x-api-key': KEY } });
      const body = await res.text();
      assert.doesNotMatch(body, /abc123|partyToken/);

      const stats = JSON.parse(body) as StatsPayload;
      assert.equal(stats.status, 'idle');
      assert.deepEqual(stats.clients, { total: 2, tv: 1, remotes: 1 });
      assert.equal(stats.tvConnected, true);
      assert.equal(stats.photos, 0);
      assert.deepEqual(stats.cache, { files: 1, bytes: 1024, maxBytes: 1024 ** 3, percent: 0 });
      assert.equal(typeof stats.uptime, 'number');
    } finally {
      tv.close();
      guest.close();
    }
  });
});

describe('GET /api/stats without STATS_API_KEY', () => {
  let dir = '';
  let server: Booted;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'singpulse-stats-'));
    server = await boot({ STATS_API_KEY: '' }, dir);
  });

  after(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is open on the LAN and closed to tunnel traffic', async () => {
    assert.equal((await fetch(`${server.base}/api/stats`)).status, 200);
    assert.equal((await fetch(`${server.base}/api/stats`, { headers: REMOTE })).status, 401);
  });
});
