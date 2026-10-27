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

const MAX_CONCURRENT_DOWNLOADS = 3;

const singerKey = (singer: string): string => singer.trim().toLowerCase();

export class QueueManager {
  private currentSong: QueueItem | null = null;
  private queue: QueueItem[] = [];
  private isPaused = false;
  private fairQueueEnabled = true;
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
      queue: this.queue,
      fairQueueEnabled: this.fairQueueEnabled
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

  // Fair rotation: every singer's Nth queued song plays before anyone's (N+1)th.
  // The new item goes after the last entry whose round is <= its own, so
  // chronological order is kept within a round and manual host ordering of the
  // rest of the queue is left alone.
  private insertWithFairRotation(newItem: QueueItem): void {
    if (!this.fairQueueEnabled) {
      this.queue.push(newItem);
      return;
    }
    const newRound = (this.countBySinger().get(singerKey(newItem.singer)) ?? 0) + 1;
    const seen = new Map<string, number>();
    let insertAt = 0;
    for (const [i, queued] of this.queue.entries()) {
      const key = singerKey(queued.singer);
      const round = (seen.get(key) ?? 0) + 1;
      seen.set(key, round);
      if (round <= newRound) insertAt = i + 1;
    }
    this.queue.splice(insertAt, 0, newItem);
  }

  // Number of songs each singer already has queued
  private countBySinger(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of this.queue) {
      const key = singerKey(item.singer);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  // Stable re-interleave of the whole queue by per-singer round
  private rebalance(): void {
    const seen = new Map<string, number>();
    const ranked = this.queue.map((item) => {
      const key = singerKey(item.singer);
      const round = (seen.get(key) ?? 0) + 1;
      seen.set(key, round);
      return { item, round };
    });
    ranked.sort((a, b) => a.round - b.round); // Array.prototype.sort is stable
    this.queue = ranked.map((r) => r.item);
  }

  public setFairQueue(enabled: boolean): void {
    if (enabled && !this.fairQueueEnabled) this.rebalance();
    this.fairQueueEnabled = enabled;
    this.sync();
    void this.processQueue();
  }

  // Host override: honoured even when fair queue is on
  public reorder(id: string, toIndex: number): boolean {
    const from = this.queue.findIndex((item) => item.id === id);
    if (from === -1 || !Number.isInteger(toIndex)) return false;
    const [moved] = this.queue.splice(from, 1);
    if (!moved) return false;
    this.queue.splice(Math.max(0, Math.min(toIndex, this.queue.length)), 0, moved);
    this.sync();
    void this.processQueue();
    return true;
  }

  public updateSinger(id: string, newSinger: string): boolean {
    const singer = newSinger.trim();
    const item = this.queue.find((q) => q.id === id);
    if (!item || !singer) return false;
    item.singer = singer;
    this.sync();
    return true;
  }

  public setPartyToken(token: string): void {
    this.partyToken = token;
    this.sync();
  }

  public remove(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => item.id !== id);
    const removed = this.queue.length !== before;
    this.sync();
    void this.processQueue();
    return removed;
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
      if (nextSong) {
        nextSong.status = 'playing';
        this.currentSong = nextSong;
        this.isPaused = false;
      }
    }
    this.sync();
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    // Pre-fetch the upcoming queued songs, at most 3 downloads in flight at once
    const freeSlots = MAX_CONCURRENT_DOWNLOADS - this.activeDownloads.size;
    if (freeSlots <= 0) return;

    const candidates = this.queue
      .filter((q) => q.status === 'queued' && !this.activeDownloads.has(q.id))
      .slice(0, freeSlots);

    for (const item of candidates) {
      this.activeDownloads.add(item.id);
      item.status = 'downloading';
      item.progress = 0;
      this.sync();

      downloadKaraokeVideo(item.videoId, (percent) => {
        // Only rebroadcast on visible changes: the UI renders 10 progress segments
        const changedSegment = Math.floor(percent / 10) !== Math.floor((item.progress ?? 0) / 10);
        item.progress = percent;
        if (changedSegment && item.status === 'downloading') this.sync();
      })
        .then((mediaUrl) => {
          item.mediaUrl = mediaUrl;
          item.status = 'ready';
          item.progress = 100;
          this.activeDownloads.delete(item.id);
          if (!this.currentSong) {
            this.advancePlayback();
          } else {
            this.sync();
            void this.processQueue();
          }
        })
        .catch((err: unknown) => {
          item.status = 'error';
          item.errorMessage = err instanceof Error ? err.message : 'Download failed';
          delete item.progress;
          this.activeDownloads.delete(item.id);
          this.sync();
          void this.processQueue();
        });
    }
  }

  private sync(): void {
    this.broadcast(this.getState());
  }
}
