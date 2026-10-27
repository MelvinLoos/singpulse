import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { QueueItem, WsOutboundMessage } from '@singpulse/shared/types';

interface Deferred {
  resolve: (mediaUrl: string) => void;
  reject: (err: Error) => void;
  onProgress?: (percent: number) => void;
}

// Replace the yt-dlp layer with controllable promises so no process is ever spawned.
const downloads = new Map<string, Deferred>();
mock.module(new URL('../src/ytdlp.ts', import.meta.url).href, {
  namedExports: {
    downloadKaraokeVideo: (videoId: string, onProgress?: (percent: number) => void) =>
      new Promise<string>((resolve, reject) => {
        downloads.set(videoId, { resolve, reject, onProgress });
      })
  }
});

const { QueueManager } = await import('../src/queueManager.ts');

function track(videoId: string, singer: string): Omit<QueueItem, 'id' | 'status'> {
  return { videoId, singer, title: `Track ${videoId}`, duration: 180, thumbnail: '' };
}

const videoId = (n: number) => `video${String(n).padStart(6, '0')}`;

const queueOrder = (m: { getState(): { queue: QueueItem[] } }): string[] => m.getState().queue.map((q) => q.videoId);

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('QueueManager', () => {
  let messages: WsOutboundMessage[];
  let manager: InstanceType<typeof QueueManager>;

  beforeEach(() => {
    downloads.clear();
    messages = [];
    manager = new QueueManager('abc123', 'https://sing.example.com', (msg) => messages.push(msg));
  });

  it('interleaves singers in fair rotation', () => {
    manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
    manager.enqueue(track('aaaaaaaaaa2', 'alice '));
    manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
    manager.enqueue(track('cccccccccc1', 'Cleo'));

    const order = manager.getState().queue.map((q) => q.videoId);
    assert.deepEqual(order, ['aaaaaaaaaa1', 'bbbbbbbbbb1', 'cccccccccc1', 'aaaaaaaaaa2']);
  });

  it('caps concurrent pre-fetches at three', () => {
    for (let i = 0; i < 5; i++) manager.enqueue(track(videoId(i), `Singer ${i}`));

    const statuses = manager.getState().queue.map((q) => q.status);
    assert.equal(statuses.filter((s) => s === 'downloading').length, 3);
    assert.equal(statuses.filter((s) => s === 'queued').length, 2);
    assert.equal(downloads.size, 3);
  });

  it('starts the next download when a slot frees up', async () => {
    for (let i = 0; i < 4; i++) manager.enqueue(track(videoId(i), `Singer ${i}`));
    downloads.get(videoId(0))?.reject(new Error('Video unavailable'));
    await flush();

    const queue = manager.getState().queue;
    assert.equal(queue.find((q) => q.videoId === videoId(0))?.status, 'error');
    assert.equal(queue.find((q) => q.videoId === videoId(0))?.errorMessage, 'Video unavailable');
    assert.equal(queue.find((q) => q.videoId === videoId(3))?.status, 'downloading');
  });

  it('promotes the first ready track to playing when idle', async () => {
    manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
    downloads.get('aaaaaaaaaa1')?.resolve('/media/aaaaaaaaaa1.mp4');
    await flush();

    const state = manager.getState();
    assert.equal(state.currentSong?.videoId, 'aaaaaaaaaa1');
    assert.equal(state.currentSong?.status, 'playing');
    assert.equal(state.currentSong?.mediaUrl, '/media/aaaaaaaaaa1.mp4');
    assert.equal(state.queue.length, 0);
  });

  it('advances only when the current song is the one that ended', async () => {
    manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
    manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
    downloads.get('aaaaaaaaaa1')?.resolve('/media/aaaaaaaaaa1.mp4');
    downloads.get('bbbbbbbbbb1')?.resolve('/media/bbbbbbbbbb1.mp4');
    await flush();

    const current = manager.getState().currentSong;
    assert.ok(current);
    manager.handleSongEnded('not-the-current-id');
    assert.equal(manager.getState().currentSong?.id, current.id);

    manager.handleSongEnded(current.id);
    assert.equal(manager.getState().currentSong?.videoId, 'bbbbbbbbbb1');
  });

  it('reports download progress in 10% steps', () => {
    manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
    const before = messages.length;
    const { onProgress } = downloads.get('aaaaaaaaaa1') ?? {};
    onProgress?.(3);
    onProgress?.(7);
    onProgress?.(12);

    assert.equal(messages.length - before, 1);
    assert.equal(manager.getState().queue[0]?.progress, 12);
  });

  it('toggles pause and relays player commands', () => {
    manager.sendCommand({ action: 'toggle_pause' });
    assert.equal(manager.getState().isPaused, true);
    assert.deepEqual(messages.at(-1), { type: 'PLAYER_COMMAND', command: { action: 'toggle_pause' } });

    manager.sendCommand({ action: 'restart' });
    assert.deepEqual(messages.at(-1), { type: 'PLAYER_COMMAND', command: { action: 'restart' } });
  });

  it('removes queued entries by id', () => {
    const item = manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
    manager.remove(item.id);
    assert.equal(manager.getState().queue.length, 0);
  });

  describe('host controls', () => {
    it('round-robins by normalized singer name', () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      manager.enqueue(track('aaaaaaaaaa2', 'Alice'));
      manager.enqueue(track('aaaaaaaaaa3', ' ALICE '));
      manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
      manager.enqueue(track('bbbbbbbbbb2', 'bob'));

      assert.deepEqual(queueOrder(manager), ['aaaaaaaaaa1', 'bbbbbbbbbb1', 'aaaaaaaaaa2', 'bbbbbbbbbb2', 'aaaaaaaaaa3']);
    });

    it('appends in arrival order when fair queue is off', () => {
      manager.setFairQueue(false);
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      manager.enqueue(track('aaaaaaaaaa2', 'Alice'));
      manager.enqueue(track('bbbbbbbbbb1', 'Bob'));

      assert.equal(manager.getState().fairQueueEnabled, false);
      assert.deepEqual(queueOrder(manager), ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'bbbbbbbbbb1']);
    });

    it('re-interleaves an existing queue when fair queue is switched on', () => {
      manager.setFairQueue(false);
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      manager.enqueue(track('aaaaaaaaaa2', 'Alice'));
      manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
      manager.enqueue(track('bbbbbbbbbb2', 'Bob'));
      manager.enqueue(track('cccccccccc1', 'Cleo'));

      manager.setFairQueue(true);

      assert.deepEqual(queueOrder(manager), ['aaaaaaaaaa1', 'bbbbbbbbbb1', 'cccccccccc1', 'aaaaaaaaaa2', 'bbbbbbbbbb2']);
      assert.equal(messages.at(-1)?.type, 'STATE_SYNC');
    });

    it('lets the host reorder against fair rotation', () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
      manager.enqueue(track('cccccccccc1', 'Cleo'));
      const cleo = manager.getState().queue[2];
      assert.ok(cleo);

      assert.equal(manager.reorder(cleo.id, 0), true);
      assert.deepEqual(queueOrder(manager), ['cccccccccc1', 'aaaaaaaaaa1', 'bbbbbbbbbb1']);
      assert.equal(manager.reorder(cleo.id, 99), true); // clamps to the end
      assert.deepEqual(queueOrder(manager), ['aaaaaaaaaa1', 'bbbbbbbbbb1', 'cccccccccc1']);
      assert.equal(manager.reorder('missing', 0), false);
    });

    it('vetoes a queued track', () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
      const alice = manager.getState().queue[0];
      assert.ok(alice);
      const before = messages.length;

      assert.equal(manager.remove(alice.id), true);
      assert.deepEqual(queueOrder(manager), ['bbbbbbbbbb1']);
      assert.ok(messages.length > before);
      assert.equal(manager.remove(alice.id), false);
    });

    it('renames a singer without reordering', () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Alcie'));
      manager.enqueue(track('bbbbbbbbbb1', 'Bob'));
      const typo = manager.getState().queue[0];
      assert.ok(typo);

      assert.equal(manager.updateSinger(typo.id, '  Alice '), true);
      assert.equal(manager.getState().queue[0]?.singer, 'Alice');
      assert.deepEqual(queueOrder(manager), ['aaaaaaaaaa1', 'bbbbbbbbbb1']);
      assert.equal(manager.updateSinger(typo.id, '   '), false);
      assert.equal(manager.updateSinger('missing', 'X'), false);
    });

    it('swaps the party token and rebroadcasts state', () => {
      manager.setPartyToken('zzz999');
      assert.equal(manager.getState().partyToken, 'zzz999');
      assert.equal(messages.at(-1)?.type, 'STATE_SYNC');
    });
  });
});
