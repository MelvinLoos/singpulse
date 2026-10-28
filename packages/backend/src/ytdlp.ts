// packages/backend/src/ytdlp.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { SearchResult } from '@singpulse/shared/types';

const execFileAsync = promisify(execFile);
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const MAX_CACHE_BYTES = Number(process.env.MAX_CACHE_GB || 25) * 1024 * 1024 * 1024;

const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// Emitted by yt-dlp once per progress tick via --progress-template (see downloadKaraokeVideo).
const PROGRESS_LINE_REGEX = /^singpulse-progress (\d+|NA)\/(\d+|NA)$/;

export type ProgressFn = (percent: number) => void;

// Concurrent requests for the same video share one yt-dlp process instead of
// racing to write the same --no-part output file.
const inFlightDownloads = new Map<string, Promise<string>>();

export function validateVideoId(videoId: string): boolean {
  return YT_ID_REGEX.test(videoId);
}

export async function searchYouTubeKaraoke(query: string): Promise<SearchResult[]> {
  // Unicode-aware so non-ASCII artists/titles (e.g. "Beyoncé", Japanese titles) survive.
  const sanitized = query.replace(/[^\p{L}\p{N}\s'-]/gu, '').trim().slice(0, 80);
  if (!sanitized) return [];

  const { stdout } = await execFileAsync('yt-dlp', [
    `ytsearch10:${sanitized} karaoke`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-errors'
  ], { timeout: 10000 });

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => toSearchResult(JSON.parse(line)))
    .filter((item) => validateVideoId(item.videoId));
}

interface YtDlpEntry {
  id: string;
  title?: string;
  duration?: number;
  thumbnails?: Array<{ url?: string }>;
  uploader?: string;
  channel?: string;
}

export function toSearchResult(data: YtDlpEntry): SearchResult {
  return {
    videoId: data.id,
    title: data.title ?? '',
    duration: data.duration || 0,
    thumbnail: data.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`,
    channel: data.uploader || data.channel || 'YouTube'
  };
}

const MAX_LOOKUP_CACHE = 100;
const lookupCache = new Map<string, SearchResult>();

/** Resolves one video by id (for shared YouTube links). Successful lookups are cached. */
export async function lookupYouTubeVideo(videoId: string): Promise<SearchResult> {
  if (!validateVideoId(videoId)) throw new Error('Invalid YouTube Video ID');
  const cached = lookupCache.get(videoId);
  if (cached) return cached;

  const { stdout } = await execFileAsync('yt-dlp', [
    '--dump-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    `https://www.youtube.com/watch?v=${videoId}`
  ], { timeout: 10000 });

  const result = toSearchResult(JSON.parse(stdout.trim().split('\n')[0] ?? ''));
  if (!validateVideoId(result.videoId)) throw new Error('Unexpected yt-dlp response');
  if (lookupCache.size >= MAX_LOOKUP_CACHE) {
    const oldest = lookupCache.keys().next().value;
    if (oldest !== undefined) lookupCache.delete(oldest);
  }
  lookupCache.set(videoId, result);
  return result;
}

export async function downloadKaraokeVideo(videoId: string, onProgress?: ProgressFn): Promise<string> {
  if (!validateVideoId(videoId)) {
    throw new Error('Invalid YouTube Video ID');
  }

  const outputPath = path.join(CACHE_DIR, `${videoId}.mp4`);
  if (existsSync(outputPath)) {
    touchCacheEntry(outputPath);
    return `/media/${videoId}.mp4`;
  }

  const pending = inFlightDownloads.get(videoId);
  if (pending) return pending;

  const download = runDownload(videoId, outputPath, onProgress).finally(() => {
    inFlightDownloads.delete(videoId);
  });
  inFlightDownloads.set(videoId, download);
  return download;
}

async function runDownload(videoId: string, outputPath: string, onProgress?: ProgressFn): Promise<string> {
  evictOldCacheIfNeeded();

  const child = execFileAsync('yt-dlp', [
    `https://www.youtube.com/watch?v=${videoId}`,
    // Enforce H.264 + AAC up to 1080p for universal hardware decoding on Android TV devices
    '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=1080][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    // Strip non-singing intros, outros, and sponsor segments automatically
    '--sponsorblock-remove', 'sponsor,intro,outro,selfpromo,interaction,music_offtopic',
    '--no-playlist',
    '--no-part',
    // Machine-readable progress, one line per tick, for the TV/remote status bars
    '--newline',
    '--progress-template', 'download:singpulse-progress %(progress.downloaded_bytes)d/%(progress.total_bytes,progress.total_bytes_estimate)d',
    '-o', outputPath
  ], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });

  if (onProgress) {
    child.child.stdout?.on('data', createProgressParser(onProgress));
  }

  try {
    await child;
  } catch (err) {
    // A killed/failed --no-part download can leave a truncated file that would
    // otherwise be served as a cache hit forever.
    removeQuietly(outputPath);
    throw new Error(describeYtDlpFailure(err), { cause: err });
  }

  return `/media/${videoId}.mp4`;
}

// Turn execFile failures into a short message that is safe to show to guests.
function describeYtDlpFailure(err: unknown): string {
  const failure = err as { code?: unknown; killed?: boolean; stderr?: string };
  if (failure.code === 'ENOENT') return 'yt-dlp is not installed on the server';
  if (failure.killed) return 'Download timed out';
  const ytDlpError = failure.stderr?.match(/ERROR: (?:\[[^\]]+\] )?(?:[\w-]{11}: )?(.+)/)?.[1];
  return ytDlpError?.trim().slice(0, 160) || 'Download failed';
}

// yt-dlp downloads video and audio as separate streams before merging. Map the
// first (video) stream to 0-90% and any later stream to the remaining 10% so the
// reported percentage only ever moves forward.
function createProgressParser(onProgress: ProgressFn): (chunk: Buffer) => void {
  let stream = 0;
  let lastStreamPercent = 0;
  let lastReported = -1;
  let buffered = '';

  return (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const match = PROGRESS_LINE_REGEX.exec(line.trim());
      if (!match || match[1] === 'NA' || match[2] === 'NA') continue;

      const total = Number(match[2]);
      if (total <= 0) continue;
      const streamPercent = Math.min(100, (Number(match[1]) / total) * 100);

      if (streamPercent + 5 < lastStreamPercent) stream += 1;
      lastStreamPercent = streamPercent;

      const overall = stream === 0 ? streamPercent * 0.9 : 90 + streamPercent * 0.1;
      const rounded = Math.floor(Math.min(99, overall));
      if (rounded > lastReported) {
        lastReported = rounded;
        onProgress(rounded);
      }
    }
  };
}

// Refresh mtime on cache hits so eviction is least-recently-used, not oldest-downloaded.
function touchCacheEntry(fullPath: string): void {
  try {
    const now = new Date();
    utimesSync(fullPath, now, now);
  } catch {
    // Non-fatal: worst case the entry is evicted a little earlier
  }
}

function removeQuietly(fullPath: string): void {
  try {
    unlinkSync(fullPath);
  } catch {
    // File was never created
  }
}

interface CachedFile {
  fullPath: string;
  mtimeMs: number;
  size: number;
}

function listCachedVideos(): CachedFile[] {
  return readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => {
      const fullPath = path.join(CACHE_DIR, f);
      const stats = statSync(fullPath);
      return { fullPath, mtimeMs: stats.mtimeMs, size: stats.size };
    });
}

export interface CacheStats {
  files: number;
  bytes: number;
  maxBytes: number;
}

export function cacheStats(): CacheStats {
  let files: CachedFile[] = [];
  try {
    files = listCachedVideos();
  } catch {
    // Cache directory missing or unreadable: report it as empty
  }
  return {
    files: files.length,
    bytes: files.reduce((acc, f) => acc + f.size, 0),
    maxBytes: MAX_CACHE_BYTES
  };
}

function evictOldCacheIfNeeded(): void {
  try {
    const files = listCachedVideos().toSorted((a, b) => a.mtimeMs - b.mtimeMs); // Oldest first

    let totalSize = files.reduce((acc, f) => acc + f.size, 0);
    for (const file of files) {
      if (totalSize <= MAX_CACHE_BYTES) break;
      unlinkSync(file.fullPath);
      totalSize -= file.size;
    }
  } catch {
    // Ignore eviction errors on empty directory
  }
}
