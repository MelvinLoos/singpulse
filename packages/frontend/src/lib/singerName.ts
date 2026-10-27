import { ref } from 'vue';

const STORAGE_KEY = 'singpulse_singer_name';
export const MAX_SINGER_NAME_LENGTH = 24;

function readStoredName(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Private browsing / blocked storage: fall back to in-memory only
    return '';
  }
}

/** Normalises a stage name; returns '' when the input is unusable. */
export function normaliseSingerName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SINGER_NAME_LENGTH);
}

const singerName = ref(normaliseSingerName(readStoredName()));

/** Persistent guest identity, kept in localStorage where available. */
export function useSingerName() {
  function save(raw: string): boolean {
    const name = normaliseSingerName(raw);
    if (!name) return false;
    singerName.value = name;
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // Keep the in-memory value for this session
    }
    return true;
  }

  return { singerName, save };
}
