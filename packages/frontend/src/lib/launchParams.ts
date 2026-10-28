const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export type LaunchAction = 'search' | 'setlist';

export interface LaunchParams {
  action: LaunchAction | null;
  /** YouTube id found in a shared link, if any */
  videoId: string | null;
  /** Shared text with any URL removed, used to prefill search */
  text: string;
}

/** Pulls a video id out of watch / youtu.be / shorts / music / mobile links. */
export function extractYouTubeId(input: string): string | null {
  for (const match of input.matchAll(/https?:\/\/[^\s]+/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
    else if (host === 'youtube.com') {
      const [, kind, second] = url.pathname.split('/');
      if (kind === 'watch') id = url.searchParams.get('v');
      else if (kind === 'shorts' || kind === 'embed' || kind === 'live') id = second ?? null;
    }
    if (id && YT_ID.test(id)) return id;
  }
  return null;
}

const LAUNCH_KEYS = ['action', 'share_title', 'share_text', 'share_url'] as const;

export function hasLaunchParams(query: Record<string, unknown>): boolean {
  return LAUNCH_KEYS.some((key) => key in query);
}

/** Parses shortcut / share-target params from any URL without touching the address bar. */
export function readLaunchParams(url: URL): LaunchParams {
  const params = url.searchParams;
  const action = params.get('action');
  const parts = LAUNCH_KEYS.slice(1)
    .map((key) => params.get(key))
    .filter((part): part is string => Boolean(part));

  // Android shares often repeat the title inside the text: keep each distinct phrase once
  const phrases: string[] = [];
  for (const part of parts) {
    const phrase = part.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (phrase && !phrases.some((seen) => seen.includes(phrase) || phrase.includes(seen))) phrases.push(phrase);
  }

  return {
    action: action === 'search' || action === 'setlist' ? action : null,
    videoId: extractYouTubeId(parts.join(' ')),
    text: phrases.join(' ').slice(0, 80)
  };
}

/** Reads the current URL's launch params once, then strips them. The party token stays. */
export function consumeLaunchParams(): LaunchParams {
  const url = new URL(window.location.href);
  const launch = readLaunchParams(url);
  const touched = LAUNCH_KEYS.filter((key) => url.searchParams.has(key));
  if (touched.length) {
    for (const key of touched) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', url);
  }
  return launch;
}
