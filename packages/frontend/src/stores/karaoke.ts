// packages/frontend/src/stores/karaoke.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  QueueItem,
  SearchResult,
  PlaybackCommand,
  WsOutboundMessage
} from '@singpulse/shared/types';

export const useKaraokeStore = defineStore('karaoke', () => {
  const partyToken = ref<string>(new URLSearchParams(window.location.search).get('token') || '');
  const remoteBaseUrl = ref<string>(window.location.origin);
  const currentSong = ref<QueueItem | null>(null);
  const queue = ref<QueueItem[]>([]);
  const isPaused = ref<boolean>(false);
  const connected = ref<boolean>(false);

  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let onCommandCallback: ((cmd: PlaybackCommand) => void) | null = null;

  const qrJoinUrl = computed(() => {
    return `${remoteBaseUrl.value}/remote?token=${partyToken.value}`;
  });

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(partyToken.value)}`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      connected.value = true;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PING' }));
        }
      }, 15000);
    });

    ws.addEventListener('message', (event) => {
      let data: WsOutboundMessage;
      try {
        data = JSON.parse(event.data) as WsOutboundMessage;
      } catch {
        return;
      }
      if (data.type === 'PONG') return;
      if (data.type === 'STATE_SYNC') {
        partyToken.value = data.partyToken;
        remoteBaseUrl.value = data.remoteBaseUrl;
        currentSong.value = data.currentSong;
        queue.value = data.queue;
        isPaused.value = data.isPaused;
      } else if (data.type === 'PLAYER_COMMAND' && onCommandCallback) {
        onCommandCallback(data.command);
      }
    });

    ws.addEventListener('close', () => {
      connected.value = false;
      if (pingTimer) clearInterval(pingTimer);
      setTimeout(connect, 2000);
    });
  }

  function notifySongEnded(id: string) {
    ws?.send(JSON.stringify({ type: 'SONG_ENDED', id }));
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

  return {
    partyToken,
    remoteBaseUrl,
    qrJoinUrl,
    currentSong,
    queue,
    isPaused,
    connected,
    connect,
    notifySongEnded,
    sendCommand,
    registerCommandHandler,
    searchSongs,
    enqueueSong,
    removeQueueItem
  };
});
