// packages/frontend/src/stores/karaoke.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  AdminRotateTokenResponse,
  QueueItem,
  SearchResult,
  PlaybackCommand,
  PolaroidItem,
  SubmitPolaroidRequest,
  VoteSuperlative,
  VotingSessionState,
  WsOutboundMessage
} from '@singpulse/shared/types';
import { compressPhoto } from '../lib/imageResize.ts';
import { normaliseSingerName } from '../lib/singerName.ts';

const ADMIN_PIN_KEY = 'singpulse_admin_pin';
const VOTER_ID_KEY = 'singpulse_voter_id';
const WS_CLOSE_TOKEN_ROTATED = 4001;
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

export const useKaraokeStore = defineStore('karaoke', () => {
  const partyToken = ref<string>(new URLSearchParams(window.location.search).get('token') || '');
  const remoteBaseUrl = ref<string>(window.location.origin);
  const currentSong = ref<QueueItem | null>(null);
  const queue = ref<QueueItem[]>([]);
  const isPaused = ref<boolean>(false);
  const connected = ref<boolean>(false);
  const fairQueueEnabled = ref<boolean>(true);
  // Set when the server drops us because the party token was rotated or is dead
  const tokenExpired = ref<boolean>(false);
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
  const burstTimers = new Set<ReturnType<typeof setTimeout>>();

  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let role: 'tv' | 'guest' = 'guest';
  // True while this client's own rotation is in flight: its socket is dropped too
  let rotatingSelf = false;
  let onCommandCallback: ((cmd: PlaybackCommand) => void) | null = null;

  const qrJoinUrl = computed(() => {
    return `${remoteBaseUrl.value}/remote?token=${partyToken.value}`;
  });

  function connect(nextRole: 'tv' | 'guest' = role) {
    role = nextRole;
    if (tokenExpired.value) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const roleParam = role === 'tv' ? '&role=tv' : '';
    const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(partyToken.value)}${roleParam}`;
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener('open', () => {
      connected.value = true;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'PING' }));
        }
      }, 15000);
    });

    socket.addEventListener('message', (event) => {
      let data: WsOutboundMessage;
      try {
        data = JSON.parse(event.data) as WsOutboundMessage;
      } catch {
        return;
      }
      if (data.type === 'PONG') return;
      if (data.type === 'STATE_SYNC') {
        // Only the TV is told the live token; everyone else keeps what they hold
        if (data.partyToken) setPartyToken(data.partyToken);
        remoteBaseUrl.value = data.remoteBaseUrl;
        currentSong.value = data.currentSong;
        queue.value = data.queue;
        isPaused.value = data.isPaused;
        fairQueueEnabled.value = data.fairQueueEnabled;
        activeVote.value = data.activeVote;
        polaroids.value = data.polaroids;
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
        if (!rotatingSelf) tokenExpired.value = true;
        return;
      }
      reconnectTimer = setTimeout(() => connect(), 2000);
    });
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
