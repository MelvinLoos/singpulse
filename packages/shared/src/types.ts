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

// A saved instant-film photo on the club wall (image lives under /media/polaroids/)
export interface PolaroidItem {
  id: string;
  imageUrl: string;        // e.g. '/media/polaroids/<id>.jpg'
  sender: string;
  caption?: string;
  rotationDeg: number;     // -6..+6 tilt
  createdAt: number;       // epoch ms
}

export interface SubmitPolaroidRequest {
  imageDataUrl: string;    // 'data:image/jpeg;base64,...' or 'data:image/webp;base64,...'
  sender: string;
  caption?: string;
}

export type VoteSuperlative = 'GRAMMY_WORTHY' | 'PURE_PASSION' | 'STAGE_LEGEND' | 'RIP_EARS';

export interface VotingSessionState {
  songId: string;
  songTitle: string;
  singer: string;
  endsAt: number;          // epoch ms, 10 seconds after the song ended
  totalVotes: number;
  averageStars: number;    // 1.0 to 5.0 (0 while no votes)
  superlativeCounts: Record<VoteSuperlative, number>;
  revealed: boolean;       // false during the first 7s, true for the final 3s reveal
}

export interface VoteSubmission {
  songId: string;
  voterId: string;
  stars: number;
  superlative?: VoteSuperlative;
}

// --- Trivia Blitz: opt-in OpenTDB party quiz between karaoke sets ---

export type TriviaCategoryKey =
  | 'MUSIC'          // OpenTDB cat 12
  | 'FILM_TV'        // OpenTDB cat 11 or 14
  | 'VIDEO_GAMES'    // OpenTDB cat 15
  | 'POP_CULTURE'    // OpenTDB cat 26 (Celebrities) / 9
  | 'PARTY_MIX';     // Any category

export type TriviaDifficulty = 'easy' | 'medium' | 'hard' | 'mixed';

export type TriviaPhase = 'LOBBY' | 'QUESTION' | 'REVEAL' | 'PODIUM';

export type TriviaOptionId = 'A' | 'B' | 'C' | 'D';

export interface TriviaPlayer {
  playerId: string;
  name: string;
  score: number;
  streak: number;
  hasAnsweredCurrent: boolean;
  lastPointsEarned: number;
  lastAnswerCorrect: boolean | null; // null = no answer this round; only updated at REVEAL
}

export interface TriviaOption {
  id: TriviaOptionId;
  text: string;
}

export interface TriviaGameState {
  gameId: string;
  phase: TriviaPhase;
  category: TriviaCategoryKey;
  difficulty: TriviaDifficulty;
  roundIndex: number;        // 0-based current question index
  totalRounds: number;       // e.g., 5 or 10
  players: TriviaPlayer[];   // Only explicitly opted-in players
  phaseEndsAt: number | null; // Timestamp (ms) for QUESTION (14s), REVEAL (4.5s), or PODIUM (12s)
  questionText?: string;
  questionCategoryLabel?: string;
  questionDifficulty?: 'easy' | 'medium' | 'hard';
  options?: TriviaOption[];
  lockedInCount: number;     // How many joined players have answered the current question
  correctOptionId?: TriviaOptionId; // ONLY populated during 'REVEAL' phase!
  roundFastestPlayerName?: string | null;
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
  activeVote: VotingSessionState | null;
  polaroids: PolaroidItem[];  // latest saved photos, oldest first
  activeTrivia: TriviaGameState | null;
}

export interface ServerPolaroidPayload {
  type: 'POLAROID_BURST';
  payload: PolaroidItem;
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
  | ServerPongPayload
  | ServerPolaroidPayload;

export type WsInboundMessage =
  | { type: 'SONG_ENDED'; id: string }
  | { type: 'PLAYER_COMMAND'; command: PlaybackCommand }
  | { type: 'PING' }
  | ({ type: 'SUBMIT_VOTE' } & VoteSubmission)
  | { type: 'SKIP_VOTE' };

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

export interface AdminTriviaLobbyRequest {
  category: TriviaCategoryKey;
  difficulty: TriviaDifficulty;
  totalRounds: 5 | 10;
}

// --- Trivia Blitz guest REST payloads (party token only) ---

export interface TriviaJoinRequest {
  playerId: string;
  name: string;
}

export interface TriviaLeaveRequest {
  playerId: string;
}

export interface TriviaAnswerRequest {
  playerId: string;
  optionId: TriviaOptionId;
  name?: string;           // Lets a latecomer auto-enroll on their first tap
}

// Guest sockets dropped by a token rotation close with code 4001, reason 'PARTY_TOKEN_ROTATED'.

// --- GET /api/stats: read-only party metrics for dashboards (gethomepage/homepage customapi) ---
// String fields are never null ('—' when empty) so dashboard widgets render cleanly.

export type PartyStatus = 'playing' | 'paused' | 'voting' | 'idle';

export interface StatsSong {
  title: string;
  singer: string;
}

export interface StatsVoteResult extends StatsSong {
  averageStars: number;
  totalVotes: number;
}

// The part of the stats owned by QueueManager
export interface QueueStats {
  status: PartyStatus;
  nowPlaying: StatsSong & { duration: number; thumbnail: string };
  nextSinger: string;
  upNext: StatsSong[];     // first 5 queued songs
  queue: { length: number; ready: number; downloading: number; errors: number };
  singers: number;         // distinct singers waiting in the queue
  songsPlayed: number;     // songs played to the end since the server started
  lastVote: StatsVoteResult | null;
  fairQueue: boolean;
}

export interface StatsPayload extends QueueStats {
  clients: { total: number; tv: number; remotes: number };
  tvConnected: boolean;
  photos: number;
  cache: { files: number; bytes: number; maxBytes: number; percent: number };
  uptime: number;          // seconds
}
