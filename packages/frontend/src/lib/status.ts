import type { QueueItem, SongStatus } from '@singpulse/shared/types';

export type StatusTone = 'idle' | 'busy' | 'ready' | 'fault';

interface StatusMeta {
  tv: string;
  remote: string;
  tone: StatusTone;
}

// One status vocabulary for both surfaces (see singpulse-design-language skill).
export const STATUS_META: Record<SongStatus, StatusMeta> = {
  queued: { tv: 'QUEUED', remote: 'QUEUED', tone: 'idle' },
  downloading: { tv: 'BUFFERING STREAM', remote: 'FETCHING', tone: 'busy' },
  ready: { tv: 'READY', remote: 'LOCKED IN', tone: 'ready' },
  playing: { tv: 'ON AIR', remote: 'ON AIR', tone: 'ready' },
  error: { tv: 'FAILED', remote: 'FAILED', tone: 'fault' }
};

export const TONE_TEXT: Record<StatusTone, string> = {
  idle: 'text-status-idle',
  busy: 'text-status-busy',
  ready: 'text-status-ready',
  fault: 'text-status-fault'
};

export const TONE_FILL: Record<StatusTone, string> = {
  idle: 'bg-status-idle',
  busy: 'bg-status-busy',
  ready: 'bg-status-ready',
  fault: 'bg-status-fault'
};

export const TONE_BORDER: Record<StatusTone, string> = {
  idle: 'border-white/25',
  busy: 'border-status-busy/60',
  ready: 'border-status-ready/60',
  fault: 'border-status-fault/60'
};

/** Number of lit segments (out of `total`) for an item's status bar. */
export function litSegments(item: Pick<QueueItem, 'status' | 'progress'>, total: number): number {
  switch (item.status) {
    case 'queued':
      return 0;
    case 'downloading':
      return Math.min(total - 1, Math.floor(((item.progress ?? 0) / 100) * total));
    default:
      return total;
  }
}
