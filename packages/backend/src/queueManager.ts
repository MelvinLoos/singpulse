// packages/backend/src/queueManager.ts
import { randomUUID } from 'node:crypto';
import { downloadKaraokeVideo } from './ytdlp.ts';
import type {
  QueueItem,
  ServerStatePayload,
  PlaybackCommand,
  PolaroidItem,
  QueueStats,
  StatsVoteResult,
  VoteSuperlative,
  VotingSessionState,
  WsOutboundMessage
} from '@singpulse/shared/types';

type BroadcastFn = (msg: WsOutboundMessage) => void;

const MAX_CONCURRENT_DOWNLOADS = 3;
const VOTE_REVEAL_MS = 7000;
const VOTE_TOTAL_MS = 10000;
const SUPERLATIVES: readonly VoteSuperlative[] = ['GRAMMY_WORTHY', 'PURE_PASSION', 'STAGE_LEGEND', 'RIP_EARS'];
const STATS_UP_NEXT = 5;
const STATS_EMPTY = '—';

interface CastVote {
  stars: number;
  superlative?: VoteSuperlative;
}

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
  private getPolaroids: () => PolaroidItem[];
  private activeVote: VotingSessionState | null = null;
  private votes = new Map<string, CastVote>();
  private voteTimers: NodeJS.Timeout[] = [];
  private songsPlayed = 0;
  private lastVote: StatsVoteResult | null = null;

  constructor(
    partyToken: string,
    remoteBaseUrl: string,
    broadcast: BroadcastFn,
    getPolaroids: () => PolaroidItem[] = () => []
  ) {
    this.partyToken = partyToken;
    this.remoteBaseUrl = remoteBaseUrl;
    this.broadcast = broadcast;
    this.getPolaroids = getPolaroids;
  }

  public getState(): ServerStatePayload {
    return {
      type: 'STATE_SYNC',
      partyToken: this.partyToken,
      remoteBaseUrl: this.remoteBaseUrl,
      isPaused: this.isPaused,
      currentSong: this.currentSong,
      queue: this.queue,
      fairQueueEnabled: this.fairQueueEnabled,
      activeVote: this.activeVote,
      polaroids: this.getPolaroids()
    };
  }

  public getStats(): QueueStats {
    const playing = this.currentSong;
    const vote = this.activeVote;
    let status: QueueStats['status'] = 'idle';
    if (playing) status = this.isPaused ? 'paused' : 'playing';
    else if (vote) status = 'voting';

    const count = (s: QueueItem['status']) => this.queue.filter((item) => item.status === s).length;
    return {
      status,
      nowPlaying: {
        title: playing?.title ?? vote?.songTitle ?? STATS_EMPTY,
        singer: playing?.singer ?? vote?.singer ?? STATS_EMPTY,
        duration: playing?.duration ?? 0,
        thumbnail: playing?.thumbnail ?? ''
      },
      nextSinger: this.queue[0]?.singer ?? STATS_EMPTY,
      upNext: this.queue.slice(0, STATS_UP_NEXT).map(({ title, singer }) => ({ title, singer })),
      queue: {
        length: this.queue.length,
        ready: count('ready'),
        downloading: count('downloading'),
        errors: count('error')
      },
      singers: new Set(this.queue.map((item) => singerKey(item.singer))).size,
      songsPlayed: this.songsPlayed,
      lastVote: this.lastVote,
      fairQueue: this.fairQueueEnabled
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
    this.clearVote();
    this.advancePlayback();
  }

  // A song that played to its end opens a 10 s crowd vote before the next track.
  // Host skips and unknown/stale ids never do.
  public handleSongEnded(id: string): void {
    if (this.currentSong && this.currentSong.id === id) {
      const song = this.currentSong;
      this.currentSong = null;
      this.isPaused = false;
      this.songsPlayed += 1;
      this.startVote(song);
    }
  }

  private startVote(song: QueueItem): void {
    this.clearVote();
    this.activeVote = {
      songId: song.id,
      songTitle: song.title,
      singer: song.singer,
      endsAt: Date.now() + VOTE_TOTAL_MS,
      totalVotes: 0,
      averageStars: 0,
      superlativeCounts: { GRAMMY_WORTHY: 0, PURE_PASSION: 0, STAGE_LEGEND: 0, RIP_EARS: 0 },
      revealed: false
    };
    this.voteTimers = [
      setTimeout(() => {
        if (!this.activeVote) return;
        this.activeVote = { ...this.activeVote, revealed: true };
        this.sync();
      }, VOTE_REVEAL_MS),
      setTimeout(() => this.skipVote(), VOTE_TOTAL_MS)
    ];
    this.sync();
  }

  public submitVote(voterId: string, songId: string, stars: number, superlative?: VoteSuperlative): boolean {
    const vote = this.activeVote;
    if (!vote || vote.revealed || vote.songId !== songId || !voterId) return false;
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return false;
    if (superlative !== undefined && !SUPERLATIVES.includes(superlative)) return false;

    this.votes.set(voterId, superlative ? { stars, superlative } : { stars });

    const counts: Record<VoteSuperlative, number> = { GRAMMY_WORTHY: 0, PURE_PASSION: 0, STAGE_LEGEND: 0, RIP_EARS: 0 };
    let starSum = 0;
    for (const cast of this.votes.values()) {
      starSum += cast.stars;
      if (cast.superlative) counts[cast.superlative] += 1;
    }
    this.activeVote = {
      ...vote,
      totalVotes: this.votes.size,
      averageStars: Math.round((starSum / this.votes.size) * 10) / 10,
      superlativeCounts: counts
    };
    this.sync();
    return true;
  }

  // Ends the intermission now (timer expiry, TV remote, or host) and starts the next song
  public skipVote(): void {
    if (!this.activeVote) return;
    this.clearVote();
    this.advancePlayback();
  }

  // Every way out of an intermission passes here, so this is where a result is kept
  private clearVote(): void {
    const vote = this.activeVote;
    if (vote && vote.totalVotes > 0) {
      this.lastVote = {
        title: vote.songTitle,
        singer: vote.singer,
        averageStars: vote.averageStars,
        totalVotes: vote.totalVotes
      };
    }
    for (const timer of this.voteTimers) clearTimeout(timer);
    this.voteTimers = [];
    this.votes.clear();
    this.activeVote = null;
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
    if (this.currentSong !== null || this.activeVote !== null) return;

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
          if (!this.currentSong && !this.activeVote) {
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

  public sync(): void {
    this.broadcast(this.getState());
  }
}
