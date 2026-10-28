// packages/backend/src/queueManager.ts
import { createHmac, randomUUID } from 'node:crypto';
import { downloadKaraokeVideo } from './ytdlp.ts';
import { TriviaService, fallbackBatch } from './triviaService.ts';
import type { TriviaQuestion, TriviaQuestionSource } from './triviaService.ts';
import type {
  QueueItem,
  TriviaCategoryKey,
  TriviaDifficulty,
  TriviaGameState,
  TriviaOptionId,
  TriviaPlayer,
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
const TRIVIA_QUESTION_MS = 14000;
const TRIVIA_REVEAL_MS = 4500;
const TRIVIA_PODIUM_MS = 12000;
const TRIVIA_PREFETCH_WAIT_MS = 6500;
const TRIVIA_MAX_PLAYERS = 50;
const TRIVIA_BASE_POINTS = 500;
const TRIVIA_SPEED_BONUS = 500;
const TRIVIA_STREAK_STEP = 100;
const TRIVIA_STREAK_CAP = 300;

export type TriviaResult = 'ok' | 'conflict' | 'no-players' | 'not-found';

// Per-round answers stay server-side until REVEAL so STATE_SYNC never shows who was right
interface RoundAnswer {
  optionId: TriviaOptionId;
  at: number;
  correct: boolean;
  points: number;
}

interface TriviaRuntime {
  state: TriviaGameState;
  gameId: string;
  prefetch: Promise<TriviaQuestion[]>;
  questions: TriviaQuestion[];
  roundAnswers: Map<string, RoundAnswer>;
}

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
  private trivia: TriviaRuntime | null = null;
  private triviaTimer: NodeJS.Timeout | null = null;
  private triviaSource: TriviaQuestionSource;
  // Per-process salt: the id broadcast in STATE_SYNC cannot be turned back into a voterId
  private triviaSalt = randomUUID();

  constructor(
    partyToken: string,
    remoteBaseUrl: string,
    broadcast: BroadcastFn,
    getPolaroids: () => PolaroidItem[] = () => [],
    triviaSource: TriviaQuestionSource = new TriviaService()
  ) {
    this.triviaSource = triviaSource;
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
      polaroids: this.getPolaroids(),
      activeTrivia: this.trivia?.state ?? null
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

  /* ------------------------------------------------------------ trivia blitz */

  // The phone's private voterId is the credential; only this derived id is ever broadcast
  public triviaPlayerId(voterId: string): string {
    return createHmac('sha256', this.triviaSalt).update(voterId).digest('hex').slice(0, 16);
  }

  public openTriviaLobby(category: TriviaCategoryKey, difficulty: TriviaDifficulty, totalRounds: number): TriviaResult {
    if (this.currentSong || this.activeVote || this.trivia) return 'conflict';
    const gameId = randomUUID();
    this.trivia = {
      gameId,
      state: {
        gameId,
        phase: 'LOBBY',
        category,
        difficulty,
        roundIndex: 0,
        totalRounds,
        players: [],
        phaseEndsAt: null,
        lockedInCount: 0
      },
      // The source never rejects; the catch is belt and braces
      prefetch: this.triviaSource.fetchBatch(category, difficulty, totalRounds).catch(() => fallbackBatch(category, totalRounds)),
      questions: [],
      roundAnswers: new Map()
    };
    this.sync();
    return 'ok';
  }

  public joinTrivia(voterId: string, name: string): TriviaResult {
    const playerId = this.triviaPlayerId(voterId);
    const game = this.trivia;
    const cleaned = name.trim();
    if (!game || !cleaned) return 'not-found';
    const existing = game.state.players.find((p) => p.playerId === playerId);
    if (existing) {
      existing.name = cleaned;
    } else {
      if (game.state.players.length >= TRIVIA_MAX_PLAYERS) return 'conflict';
      game.state.players.push(this.newPlayer(playerId, cleaned));
      this.refreshLockIns(game);
    }
    this.sync();
    return 'ok';
  }

  public leaveTrivia(voterId: string): TriviaResult {
    const playerId = this.triviaPlayerId(voterId);
    const game = this.trivia;
    if (!game) return 'not-found';
    const before = game.state.players.length;
    game.state.players = game.state.players.filter((p) => p.playerId !== playerId);
    if (game.state.players.length === before) return 'not-found';
    game.roundAnswers.delete(playerId);
    this.refreshLockIns(game);

    if (game.state.players.length === 0 && game.state.phase !== 'LOBBY') {
      this.endTrivia();
    } else if (game.state.phase === 'QUESTION' && this.allLockedIn(game)) {
      this.toReveal(game);
    } else {
      this.sync();
    }
    return 'ok';
  }

  public async startTriviaGame(): Promise<TriviaResult> {
    const game = this.trivia;
    if (!game || game.state.phase !== 'LOBBY') return 'conflict';
    if (game.state.players.length === 0) return 'no-players';

    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TRIVIA_PREFETCH_WAIT_MS);
    });
    const fetched = await Promise.race([game.prefetch, slow]);
    clearTimeout(timer);

    // The host may have ended the game, or someone else started it, while we waited
    if (this.trivia !== game || game.state.phase !== 'LOBBY') return 'conflict';
    if (game.state.players.length === 0) return 'no-players';
    game.questions = fetched && fetched.length >= game.state.totalRounds
      ? fetched
      : fallbackBatch(game.state.category, game.state.totalRounds);
    this.toQuestion(game, 0);
    return 'ok';
  }

  public submitTriviaAnswer(voterId: string, optionId: TriviaOptionId, name?: string): TriviaResult {
    const playerId = this.triviaPlayerId(voterId);
    const game = this.trivia;
    if (!game || game.state.phase !== 'QUESTION') return 'conflict';
    const question = game.questions[game.state.roundIndex];
    if (!question) return 'conflict';

    let player = game.state.players.find((p) => p.playerId === playerId);
    if (!player) {
      const cleaned = name?.trim();
      if (!cleaned) return 'not-found';
      if (game.state.players.length >= TRIVIA_MAX_PLAYERS) return 'conflict';
      player = this.newPlayer(playerId, cleaned);
      game.state.players.push(player);
    }
    if (player.hasAnsweredCurrent) return 'ok'; // duplicate taps are ignored

    const correct = optionId === question.correctOptionId;
    let points = 0;
    if (correct) {
      const remaining = Math.max(0, ((game.state.phaseEndsAt ?? 0) - Date.now()) / TRIVIA_QUESTION_MS);
      const streak = player.streak + 1;
      const streakBonus = Math.min(TRIVIA_STREAK_CAP, (streak - 1) * TRIVIA_STREAK_STEP);
      points = TRIVIA_BASE_POINTS + Math.round(remaining * TRIVIA_SPEED_BONUS) + streakBonus;
    }
    game.roundAnswers.set(playerId, { optionId, at: Date.now(), correct, points });
    player.hasAnsweredCurrent = true;
    this.refreshLockIns(game);

    if (this.allLockedIn(game)) this.toReveal(game);
    else this.sync();
    return 'ok';
  }

  public stopTrivia(): TriviaResult {
    if (!this.trivia) return 'not-found';
    this.endTrivia();
    return 'ok';
  }

  private newPlayer(playerId: string, name: string): TriviaPlayer {
    return { playerId, name, score: 0, streak: 0, hasAnsweredCurrent: false, lastPointsEarned: 0, lastAnswerCorrect: null };
  }

  // Always derived from the roster, so joins, leaves and answers cannot drift apart
  private refreshLockIns(game: TriviaRuntime): void {
    game.state.lockedInCount = game.state.players.filter((p) => p.hasAnsweredCurrent).length;
  }

  private allLockedIn(game: TriviaRuntime): boolean {
    return game.state.players.length > 0 && game.state.players.every((p) => p.hasAnsweredCurrent);
  }

  private setTriviaTimer(ms: number, fn: () => void): void {
    if (this.triviaTimer) clearTimeout(this.triviaTimer);
    this.triviaTimer = setTimeout(fn, ms);
  }

  private toQuestion(game: TriviaRuntime, index: number): void {
    const question = game.questions[index];
    if (!question) {
      this.toPodium(game);
      return;
    }
    game.roundAnswers.clear();
    for (const p of game.state.players) {
      p.hasAnsweredCurrent = false;
      p.lastPointsEarned = 0;
      p.lastAnswerCorrect = null;
    }
    const { correctOptionId: _secret, roundFastestPlayerName: _fastest, ...rest } = game.state;
    game.state = {
      ...rest,
      phase: 'QUESTION',
      roundIndex: index,
      phaseEndsAt: Date.now() + TRIVIA_QUESTION_MS,
      questionText: question.text,
      questionCategoryLabel: question.categoryLabel,
      questionDifficulty: question.difficulty,
      options: question.options,
      lockedInCount: 0
    };
    this.setTriviaTimer(TRIVIA_QUESTION_MS, () => this.toReveal(game));
    this.sync();
  }

  private toReveal(game: TriviaRuntime): void {
    if (this.trivia !== game || game.state.phase !== 'QUESTION') return;
    const question = game.questions[game.state.roundIndex];
    let fastest: { name: string; at: number } | null = null;
    for (const p of game.state.players) {
      const answer = game.roundAnswers.get(p.playerId);
      if (answer?.correct) {
        p.streak += 1;
        p.score += answer.points;
        p.lastPointsEarned = answer.points;
        p.lastAnswerCorrect = true;
        if (!fastest || answer.at < fastest.at) fastest = { name: p.name, at: answer.at };
      } else {
        p.streak = 0;
        p.lastPointsEarned = 0;
        p.lastAnswerCorrect = answer ? false : null;
      }
    }
    game.state.players.sort((a, b) => b.score - a.score); // stable: ties keep join order
    game.state = {
      ...game.state,
      phase: 'REVEAL',
      phaseEndsAt: Date.now() + TRIVIA_REVEAL_MS,
      roundFastestPlayerName: fastest?.name ?? null,
      ...(question ? { correctOptionId: question.correctOptionId } : {})
    };
    const next = game.state.roundIndex + 1;
    this.setTriviaTimer(TRIVIA_REVEAL_MS, () => {
      if (next < game.state.totalRounds) this.toQuestion(game, next);
      else this.toPodium(game);
    });
    this.sync();
  }

  private toPodium(game: TriviaRuntime): void {
    game.state = { ...game.state, phase: 'PODIUM', phaseEndsAt: Date.now() + TRIVIA_PODIUM_MS };
    this.setTriviaTimer(TRIVIA_PODIUM_MS, () => this.endTrivia());
    this.sync();
  }

  // Every way out of a game passes here: the first ready song then takes the stage
  private endTrivia(): void {
    if (this.triviaTimer) clearTimeout(this.triviaTimer);
    this.triviaTimer = null;
    this.trivia = null;
    this.advancePlayback();
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
    // Downloads keep running during trivia, but nobody takes the stage until it ends
    if (this.currentSong !== null || this.activeVote !== null || this.trivia !== null) return;

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
          if (!this.currentSong && !this.activeVote && !this.trivia) {
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
