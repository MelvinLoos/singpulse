// packages/shared/src/types.ts
//
// Single source of truth for every WebSocket message and REST payload exchanged
// between the SingPulse server, the TV receiver and the guest remotes.
// Types only: this module must stay erasable so Node 24 can strip it natively.

export type SongStatus = 'queued' | 'downloading' | 'ready' | 'playing' | 'error';

export interface QueueItem {
  id: string;              // UUID v4 for this specific queue entry
  videoId: string;         // 11-char YouTube Video ID
  title: string;           // Cleaned track title
  singer: string;          // Name of guest who queued the track
  duration: number;        // Duration in seconds
  thumbnail: string;       // URL to YouTube thumbnail
  status: SongStatus;
  progress?: number;       // Download progress percentage (0-100)
  mediaUrl?: string;       // Populated when status === 'ready' | 'playing' (e.g., '/media/dQw4w9WgXcQ.mp4')
  errorMessage?: string;
}

export interface SearchResult {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
  channel: string;
}

export interface PlaybackCommand {
  action: 'toggle_pause' | 'skip' | 'restart' | 'volume';
  value?: number;
}

export interface ServerStatePayload {
  type: 'STATE_SYNC';
  // Only sent to the TV receiver: guests and the host never learn the live token
  // from a broadcast, so a rotation cannot be undone by a kicked guest.
  partyToken?: string;
  remoteBaseUrl: string;   // Public Cloudflare Tunnel URL for QR code generation
  isPaused: boolean;
  currentSong: QueueItem | null;
  queue: QueueItem[];
  fairQueueEnabled: boolean;
}

export interface ServerCommandPayload {
  type: 'PLAYER_COMMAND';
  command: PlaybackCommand;
}

export interface ServerPongPayload {
  type: 'PONG';
}

export type WsOutboundMessage =
  | ServerStatePayload
  | ServerCommandPayload
  | ServerPongPayload;

export type WsInboundMessage =
  | { type: 'SONG_ENDED'; id: string }
  | { type: 'PLAYER_COMMAND'; command: PlaybackCommand }
  | { type: 'PING' };

// --- Host Mode (admin) REST payloads: all require the `x-admin-pin` header ---

export interface AdminReorderRequest {
  itemId: string;
  toIndex: number;
}

export interface AdminUpdateQueueItemRequest {
  singer: string;
}

export interface AdminFairQueueRequest {
  enabled: boolean;
}

export interface AdminRotateTokenResponse {
  partyToken: string;
}

// Guest sockets dropped by a token rotation close with code 4001, reason 'PARTY_TOKEN_ROTATED'.
