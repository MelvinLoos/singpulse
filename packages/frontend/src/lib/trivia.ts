import type { TriviaCategoryKey, TriviaDifficulty, TriviaGameState, TriviaPlayer } from '@singpulse/shared/types';

export const TRIVIA_QUESTION_MS = 14000;

export const TRIVIA_CATEGORIES: ReadonlyArray<{ key: TriviaCategoryKey; label: string }> = [
  { key: 'MUSIC', label: 'MUSIC' },
  { key: 'FILM_TV', label: 'FILM & TV' },
  { key: 'VIDEO_GAMES', label: 'GAMES' },
  { key: 'POP_CULTURE', label: 'POP' },
  { key: 'PARTY_MIX', label: 'MIX' }
];

export const TRIVIA_DIFFICULTIES: ReadonlyArray<{ key: TriviaDifficulty; label: string }> = [
  { key: 'easy', label: 'EASY' },
  { key: 'medium', label: 'MED' },
  { key: 'hard', label: 'HARD' },
  { key: 'mixed', label: 'MIX' }
];

export function categoryLabel(key: TriviaCategoryKey): string {
  return TRIVIA_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

/** Players ranked by score (ties keep roster order). */
export function ranked(game: Pick<TriviaGameState, 'players'>): TriviaPlayer[] {
  return game.players.toSorted((a, b) => b.score - a.score);
}

export function rankOf(game: Pick<TriviaGameState, 'players'>, playerId: string): number {
  return ranked(game).findIndex((p) => p.playerId === playerId) + 1;
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');
