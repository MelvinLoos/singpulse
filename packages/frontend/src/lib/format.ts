/** Seconds -> `MM:SS` (or `H:MM:SS` past the hour). Unknown durations render as `--:--`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '--:--';
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** Playback clock: like formatDuration, but 0 is a real position (`00:00`). */
export function formatTimecode(seconds: number): string {
  return Number.isFinite(seconds) && seconds >= 1 ? formatDuration(seconds) : '00:00';
}

/** Zero-padded queue index: 0 -> `01`. */
export function formatIndex(zeroBased: number): string {
  return String(zeroBased + 1).padStart(2, '0');
}

/** Strip the noise karaoke uploads put around the actual song name. */
export function cleanTitle(title: string): string {
  return title
    .replace(/[([{【「][^)\]}】」]*(karaoke|instrumental|lyrics?|official|version|mr|inst)[^)\]}】」]*[)\]}】」]/gi, '')
    .replace(/\b(karaoke( version)?|with lyrics|lyrics|instrumental|official (video|audio))\b/gi, '')
    .replace(/\s*[|/–—-]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || title;
}

/** `https://sing.example.com` -> `SING.EXAMPLE.COM` for compact mono readouts. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host.toUpperCase();
  } catch {
    return url.toUpperCase();
  }
}
