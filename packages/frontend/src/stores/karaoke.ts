// packages/frontend/src/stores/karaoke.ts
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type {
  AdminRotateTokenResponse,
  QueueItem,
  SearchResult,
  PlaybackCommand,
  PolaroidItem,
  SubmitPolaroidRequest,
  TriviaCategoryKey,
  TriviaDifficulty,
  TriviaGameState,
  TriviaOptionId,
  VoteSuperlative,
  VotingSessionState,
  WsOutboundMessage
} from '@singpulse/shared/types';
import { compressPhoto } from '../lib/imageResize.ts';
import { normaliseSingerName, useSingerName } from '../lib/singerName.ts';

const ADMIN_PIN_KEY = 'singpulse_admin_pin';
const PARTY_TOKEN_KEY = 'singpulse_party_token';
const VOTER_ID_KEY = 'singpulse_voter_id';
const TRIVIA_ANSWER_KEY = 'singpulse_trivia_answer';
const TRIVIA_PLAYER_KEY = 'singpulse_trivia_player';
const WS_CLOSE_TOKEN_ROTATED = 4001;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_INTERVAL_MS = 15000;
const WATCHDOG_MS = 4000;
const POLAROID_BURST_MS = 8000;
const MAX_LIVE_POLAROIDS = 3;

// randomUUID is secure-context only; guests reach us over plain HTTP on the LAN
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Anonymous per-device id so one phone gets one vote per song
function readVoterId(): string {
  try {
    const stored = localStorage.getItem(VOTER_ID_KEY);
    if (stored) return stored;
    const fresh = randomId();
    localStorage.setItem(VOTER_ID_KEY, fresh);
    return fresh;
  } catch {
    return randomId(); // Private mode: unique for this session only
  }
}

export class PolaroidCooldownError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Polaroid cooldown');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface MyVote {
  songId: string;
  stars: number;
  superlative?: VoteSuperlative;
}

interface StoredTriviaAnswer {
  gameId: string;
  roundIndex: number;
  optionId: TriviaOptionId;
}

function readTriviaAnswer(): StoredTriviaAnswer | null {
  try {
    const raw = sessionStorage.getItem(TRIVIA_ANSWER_KEY);
    return raw ? (JSON.parse(raw) as StoredTriviaAnswer) : null;
  } catch {
    return null; // Storage blocked or corrupt: the locked pads still come from the server
  }
}

function writeTriviaAnswer(entry: StoredTriviaAnswer | null): void {
  try {
    if (entry) sessionStorage.setItem(TRIVIA_ANSWER_KEY, JSON.stringify(entry));
    else sessionStorage.removeItem(TRIVIA_ANSWER_KEY);
  } catch {
    // In-memory state still works for this session
  }
}

// The server's public id for this phone in the current game (never the private voterId)
function readTriviaPlayer(): { gameId: string; playerId: string } | null {
  try {
    const raw = sessionStorage.getItem(TRIVIA_PLAYER_KEY);
    return raw ? (JSON.parse(raw) as { gameId: string; playerId: string }) : null;
  } catch {
    return null;
  }
}

function writeTriviaPlayer(entry: { gameId: string; playerId: string } | null): void {
  try {
    if (entry) sessionStorage.setItem(TRIVIA_PLAYER_KEY, JSON.stringify(entry));
    else sessionStorage.removeItem(TRIVIA_PLAYER_KEY);
  } catch {
    // In-memory state still works for this session
  }
}

function readStoredPin(): string | null {
  try {
    return localStorage.getItem(ADMIN_PIN_KEY);
  } catch {
    return null; // Private mode: fall back to in-memory only
  }
}

function writeStoredPin(pin: string | null): void {
  try {
    if (pin === null) localStorage.removeItem(ADMIN_PIN_KEY);
    else localStorage.setItem(ADMIN_PIN_KEY, pin);
  } catch {
    // In-memory state still works for this session
  }
}

function readStoredToken(): string {
  try {
    return localStorage.getItem(PARTY_TOKEN_KEY) ?? '';
  } catch {
    return ''; // Private mode: the URL token still works for this session
  }
}

function writeStoredToken(token: string): void {
  try {
    if (token) localStorage.setItem(PARTY_TOKEN_KEY, token);
  } catch {
    // In-memory state still works for this session
  }
}

// Accepts a bare code or a pasted/scanned join URL; only ever extracts the token
function parseTokenInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const fromUrl = new URL(trimmed).searchParams.get('token');
    if (fromUrl) return fromUrl.trim();
  } catch {
    // Not a URL: treat it as the code itself
  }
  return trimmed.replace(/\s+/g, '');
}

export const useKaraokeStore = defineStore('karaoke', () => {
  const urlToken = new URLSearchParams(window.location.search).get('token') || '';
  if (urlToken) writeStoredToken(urlToken);
  const partyToken = ref<string>(urlToken || readStoredToken());
  const remoteBaseUrl = ref<string>(window.location.origin);
  const currentSong = ref<QueueItem | null>(null);
  const queue = ref<QueueItem[]>([]);
  const isPaused = ref<boolean>(false);
  const connected = ref<boolean>(false);
  const fairQueueEnabled = ref<boolean>(true);
  // Set when the server drops us because the party token was rotated or is dead
  const tokenExpired = ref<boolean>(false);
  // Set when a code typed into the rejoin panel was refused as well
  const rejoinFailed = ref<boolean>(false);
  const online = ref<boolean>(navigator.onLine);
  const adminPin = ref<string | null>(readStoredPin());
  const isAdmin = ref<boolean>(false);
  const activeVote = ref<VotingSessionState | null>(null);
  const polaroids = ref<PolaroidItem[]>([]);
  const livePolaroidBursts = ref<PolaroidItem[]>([]);
  const voterId = readVoterId();
  const myCurrentVote = ref<MyVote | null>(null);
  const hasVotedCurrentSong = computed(
    () => activeVote.value !== null && myCurrentVote.value?.songId === activeVote.value.songId
  );
  const activeTrivia = ref<TriviaGameState | null>(null);
  const triviaMinimized = ref<boolean>(false);
  const myTriviaAnswer = ref<TriviaOptionId | null>(null);
  const { singerName } = useSingerName();
  const triviaPlayerId = ref<string | null>(null);
  const myTriviaPlayer = computed(
    () => activeTrivia.value?.players.find((p) => p.playerId === triviaPlayerId.value) ?? null
  );
  const isJoinedInTrivia = computed(() => myTriviaPlayer.value !== null);
  const burstTimers = new Set<ReturnType<typeof setTimeout>>();

  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let rejoining = false;
  let started = false;
  let role: 'tv' | 'guest' = 'guest';
  // True while this client's own rotation is in flight: its socket is dropped too
  let rotatingSelf = false;
  let onCommandCallback: ((cmd: PlaybackCommand) => void) | null = null;

  const qrJoinUrl = computed(() => {
    return `${remoteBaseUrl.value}/remote?token=${partyToken.value}`;
  });

  function connect(nextRole: 'tv' | 'guest' = role) {
    role = nextRole;
    started = true;
    if (tokenExpired.value) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const roleParam = role === 'tv' ? '&role=tv' : '';
    const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(partyToken.value)}${roleParam}`;
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener('open', () => {
      connected.value = true;
      reconnectAttempts = 0;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'PING' }));
        }
      }, PING_INTERVAL_MS);
    });

    socket.addEventListener('message', (event) => {
      if (ws === socket && watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      let data: WsOutboundMessage;
      try {
        data = JSON.parse(event.data) as WsOutboundMessage;
      } catch {
        return;
      }
      if (data.type === 'PONG') return;
      if (data.type === 'STATE_SYNC') {
        // The server accepts the upgrade before it checks the token: only STATE_SYNC proves it
        rejoining = false;
        rejoinFailed.value = false;
        // Only the TV is told the live token; everyone else keeps what they hold
        if (data.partyToken) setPartyToken(data.partyToken);
        remoteBaseUrl.value = data.remoteBaseUrl;
        currentSong.value = data.currentSong;
        queue.value = data.queue;
        isPaused.value = data.isPaused;
        fairQueueEnabled.value = data.fairQueueEnabled;
        activeVote.value = data.activeVote;
        polaroids.value = data.polaroids;
        activeTrivia.value = data.activeTrivia;
      } else if (data.type === 'POLAROID_BURST') {
        showPolaroidBurst(data.payload);
      } else if (data.type === 'PLAYER_COMMAND' && onCommandCallback) {
        onCommandCallback(data.command);
      }
    });

    socket.addEventListener('close', (event) => {
      if (ws !== socket) return; // Superseded by a newer connection
      connected.value = false;
      if (pingTimer) clearInterval(pingTimer);
      if (event.code === WS_CLOSE_TOKEN_ROTATED) {
        // Dead token: stop retrying. Our own rotation reconnects with the fresh one.
        if (!rotatingSelf) {
          tokenExpired.value = true;
          if (rejoining) rejoinFailed.value = true;
        }
        rejoining = false;
        return;
      }
      scheduleReconnect();
    });
  }

  // Capped exponential backoff with jitter, reset once a socket opens
  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => connect(), base * (0.75 + Math.random() * 0.5));
  }

  // Phones freeze sockets in the background: on resume, reconnect now or prove the link is alive
  function checkLink() {
    if (!started || tokenExpired.value) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws = null;
      connect();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || watchdogTimer) return;
    ws.send(JSON.stringify({ type: 'PING' }));
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      // No reply: drop the stale socket before dialling, so no duplicate lingers
      const stale = ws;
      ws = null;
      connected.value = false;
      try {
        stale?.close();
      } catch {
        // Already gone
      }
      connect();
    }, WATCHDOG_MS);
  }

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkLink());
  window.addEventListener('pageshow', (event) => event.persisted && checkLink());
  window.addEventListener('online', () => {
    online.value = true;
    checkLink();
  });
  window.addEventListener('offline', () => (online.value = false));

  // Used by the rejoin panel after the token died; resolves nothing, state flows through refs
  function rejoin(input: string) {
    const token = parseTokenInput(input);
    if (!token) return;
    rejoinFailed.value = false;
    rejoining = true;
    setPartyToken(token);
    tokenExpired.value = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    const old = ws;
    ws = null;
    try {
      old?.close();
    } catch {
      // Already gone
    }
    connect();
  }

  // A fresh photo floats over the video briefly; the wall keeps it permanently
  function showPolaroidBurst(item: PolaroidItem) {
    livePolaroidBursts.value = [...livePolaroidBursts.value, item].slice(-MAX_LIVE_POLAROIDS);
    const timer = setTimeout(() => {
      burstTimers.delete(timer);
      livePolaroidBursts.value = livePolaroidBursts.value.filter((p) => p.id !== item.id);
    }, POLAROID_BURST_MS);
    burstTimers.add(timer);
  }

  // Keep a ?token= in the address bar in step so a reload rejoins with the live token
  function setPartyToken(token: string) {
    partyToken.value = token;
    writeStoredToken(token);
    const url = new URL(window.location.href);
    if (url.searchParams.has('token') && url.searchParams.get('token') !== token) {
      url.searchParams.set('token', token);
      window.history.replaceState(window.history.state, '', url);
    }
  }

  function notifySongEnded(id: string) {
    ws?.send(JSON.stringify({ type: 'SONG_ENDED', id }));
  }

  // Tapping a star or a pad updates one vote; the other half of it is kept
  function submitCrowdVote(stars?: number, superlative?: VoteSuperlative) {
    const vote = activeVote.value;
    if (!vote || vote.revealed) return;
    const previous = myCurrentVote.value?.songId === vote.songId ? myCurrentVote.value : null;
    const nextStars = stars ?? previous?.stars ?? 3;
    const nextSuperlative = superlative ?? previous?.superlative;
    myCurrentVote.value = {
      songId: vote.songId,
      stars: nextStars,
      ...(nextSuperlative ? { superlative: nextSuperlative } : {})
    };
    ws?.send(JSON.stringify({
      type: 'SUBMIT_VOTE',
      songId: vote.songId,
      voterId,
      stars: nextStars,
      ...(nextSuperlative ? { superlative: nextSuperlative } : {})
    }));
  }

  // TV remote: cut the intermission short
  function skipVote() {
    ws?.send(JSON.stringify({ type: 'SKIP_VOTE' }));
  }

  // A new question clears the chosen pad; a reload mid-question restores it
  watch(
    () => [activeTrivia.value?.gameId, activeTrivia.value?.roundIndex] as const,
    ([gameId, roundIndex], previous) => {
      if (!gameId) {
        myTriviaAnswer.value = null;
        triviaMinimized.value = false;
        writeTriviaAnswer(null);
        writeTriviaPlayer(null);
        triviaPlayerId.value = null;
        return;
      }
      if (previous?.[0] !== gameId) triviaMinimized.value = false;
      const storedPlayer = readTriviaPlayer();
      triviaPlayerId.value = storedPlayer?.gameId === gameId ? storedPlayer.playerId : null;
      const stored = readTriviaAnswer();
      myTriviaAnswer.value =
        stored && stored.gameId === gameId && stored.roundIndex === roundIndex ? stored.optionId : null;
    }
  );

  function guestPost(path: string, body: unknown): Promise<Response> {
    return fetch(`/api/trivia${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-party-token': partyToken.value },
      body: JSON.stringify(body)
    });
  }

  async function openTriviaLobby(category: TriviaCategoryKey, difficulty: TriviaDifficulty, totalRounds: number) {
    await adminCall('/trivia/lobby', { method: 'POST', body: JSON.stringify({ category, difficulty, totalRounds }) });
  }

  async function startTriviaGame() {
    await adminCall('/trivia/start', { method: 'POST' });
  }

  async function stopTriviaGame() {
    await adminCall('/trivia/stop', { method: 'POST' });
  }

  // 'needs-name' tells the view to collect a stage name first
  function rememberTriviaPlayer(playerId: string) {
    triviaPlayerId.value = playerId;
    const gameId = activeTrivia.value?.gameId;
    if (gameId) writeTriviaPlayer({ gameId, playerId });
  }

  async function joinTrivia(): Promise<'joined' | 'needs-name'> {
    const name = normaliseSingerName(singerName.value);
    if (!name) return 'needs-name';
    const res = await guestPost('/join', { playerId: voterId, name });
    if (!res.ok) throw new Error(`Trivia join failed (${res.status})`);
    rememberTriviaPlayer(((await res.json()) as { playerId: string }).playerId);
    triviaMinimized.value = false;
    return 'joined';
  }

  async function leaveTrivia() {
    const res = await guestPost('/leave', { playerId: voterId });
    if (!res.ok && res.status !== 404) throw new Error(`Trivia leave failed (${res.status})`);
  }

  async function submitTriviaAnswer(optionId: TriviaOptionId) {
    const game = activeTrivia.value;
    if (!game || game.phase !== 'QUESTION' || myTriviaAnswer.value) return;
    myTriviaAnswer.value = optionId;
    writeTriviaAnswer({ gameId: game.gameId, roundIndex: game.roundIndex, optionId });
    try {
      const name = normaliseSingerName(singerName.value);
      const res = await guestPost('/answer', { playerId: voterId, optionId, ...(name ? { name } : {}) });
      if (!res.ok) throw new Error(`Trivia answer failed (${res.status})`);
      rememberTriviaPlayer(((await res.json()) as { playerId: string }).playerId);
    } catch (err) {
      myTriviaAnswer.value = null;
      writeTriviaAnswer(null);
      throw err;
    }
  }

  async function sendPolaroid(file: File, caption?: string, sender = 'GUEST') {
    const body: SubmitPolaroidRequest = {
      imageDataUrl: await compressPhoto(file),
      sender: normaliseSingerName(sender) || 'GUEST',
      ...(caption?.trim() ? { caption: caption.trim().slice(0, 24) } : {})
    };
    const res = await fetch('/api/polaroid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-party-token': partyToken.value },
      body: JSON.stringify(body)
    });
    if (res.status === 429) throw new PolaroidCooldownError(Number(res.headers.get('retry-after')) || 15);
    if (!res.ok) throw new Error(`Polaroid upload failed (${res.status})`);
  }

  async function deletePolaroid(id: string) {
    await adminCall(`/polaroid/${id}`, { method: 'DELETE' });
  }

  function sendCommand(command: PlaybackCommand) {
    ws?.send(JSON.stringify({ type: 'PLAYER_COMMAND', command }));
  }

  function registerCommandHandler(cb: ((cmd: PlaybackCommand) => void) | null) {
    onCommandCallback = cb;
  }

  async function searchSongs(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'x-party-token': partyToken.value },
      signal
    });
    if (!res.ok) throw new Error('Search failed');
    return res.json();
  }

  async function lookupVideo(videoId: string, signal?: AbortSignal): Promise<SearchResult> {
    const res = await fetch(`/api/video/${encodeURIComponent(videoId)}`, {
      headers: { 'x-party-token': partyToken.value },
      signal
    });
    if (!res.ok) throw new Error('Video lookup failed');
    return res.json();
  }

  async function enqueueSong(song: SearchResult, singer: string) {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-party-token': partyToken.value
      },
      body: JSON.stringify({ ...song, singer })
    });
    if (!res.ok) throw new Error('Queue request failed');
  }

  async function removeQueueItem(id: string) {
    const res = await fetch(`/api/queue/${id}`, {
      method: 'DELETE',
      headers: { 'x-party-token': partyToken.value }
    });
    if (!res.ok) throw new Error('Remove request failed');
  }

  /* ------------------------------------------------------------ host mode */
  function adminFetch(path: string, init: RequestInit = {}, pin = adminPin.value): Promise<Response> {
    const headers: Record<string, string> = {
      'x-party-token': partyToken.value,
      'x-admin-pin': pin ?? '',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    };
    return fetch(`/api/admin${path}`, { ...init, headers });
  }

  async function adminCall(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await adminFetch(path, init);
    if (res.status === 401) lockAdmin();
    if (!res.ok) throw new Error(`Admin request failed (${res.status})`);
    return res;
  }

  // Resolves false for a wrong PIN; rejects when the server cannot be reached
  async function unlockAdmin(pin: string): Promise<boolean> {
    const res = await adminFetch('/verify', { method: 'POST' }, pin);
    if (res.status === 401) return false;
    if (!res.ok) throw new Error(`Verify failed (${res.status})`);
    adminPin.value = pin;
    isAdmin.value = true;
    writeStoredPin(pin);
    return true;
  }

  // Re-validate a PIN remembered from an earlier visit
  async function restoreAdmin(): Promise<void> {
    if (!adminPin.value || isAdmin.value) return;
    try {
      const res = await adminFetch('/verify', { method: 'POST' });
      if (res.ok) isAdmin.value = true;
      else if (res.status === 401) lockAdmin();
    } catch {
      // Offline: stay locked until the next attempt
    }
  }

  function lockAdmin() {
    adminPin.value = null;
    isAdmin.value = false;
    writeStoredPin(null);
  }

  async function rotatePartyToken(): Promise<string> {
    rotatingSelf = true;
    try {
      const res = await adminCall('/rotate-token', { method: 'POST' });
      const { partyToken: next } = (await res.json()) as AdminRotateTokenResponse;
      setPartyToken(next);
      tokenExpired.value = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
      connected.value = false;
      rotatingSelf = false;
      connect();
      return next;
    } finally {
      rotatingSelf = false;
    }
  }

  async function toggleFairQueue(enabled: boolean) {
    fairQueueEnabled.value = enabled; // optimistic; STATE_SYNC confirms
    try {
      await adminCall('/fair-queue', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch (err) {
      fairQueueEnabled.value = !enabled;
      throw err;
    }
  }

  async function reorderQueue(itemId: string, toIndex: number) {
    await adminCall('/queue/reorder', { method: 'POST', body: JSON.stringify({ itemId, toIndex }) });
  }

  async function vetoSong(itemId: string) {
    await adminCall(`/queue/${itemId}`, { method: 'DELETE' });
  }

  async function renameSongSinger(itemId: string, singer: string) {
    await adminCall(`/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ singer }) });
  }

  return {
    partyToken,
    fairQueueEnabled,
    tokenExpired,
    rejoinFailed,
    online,
    rejoin,
    lookupVideo,
    adminPin,
    isAdmin,
    unlockAdmin,
    restoreAdmin,
    lockAdmin,
    rotatePartyToken,
    toggleFairQueue,
    reorderQueue,
    vetoSong,
    renameSongSinger,
    remoteBaseUrl,
    qrJoinUrl,
    currentSong,
    queue,
    isPaused,
    connected,
    connect,
    activeVote,
    activeTrivia,
    triviaMinimized,
    myTriviaAnswer,
    myTriviaPlayer,
    isJoinedInTrivia,
    openTriviaLobby,
    startTriviaGame,
    stopTriviaGame,
    joinTrivia,
    leaveTrivia,
    submitTriviaAnswer,
    polaroids,
    livePolaroidBursts,
    myCurrentVote,
    hasVotedCurrentSong,
    submitCrowdVote,
    skipVote,
    sendPolaroid,
    deletePolaroid,
    notifySongEnded,
    sendCommand,
    registerCommandHandler,
    searchSongs,
    enqueueSong,
    removeQueueItem
  };
});
