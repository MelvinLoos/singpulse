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
      for (const [i, queued] of this.queue.entries()) {
        const s = queued.singer.trim().toLowerCase();
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
