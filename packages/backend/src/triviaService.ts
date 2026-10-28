// packages/backend/src/triviaService.ts
//
// Question provider for Trivia Blitz. Talks to OpenTDB in ONE batch request per game
// and falls back to a built-in party bank so a flaky network never reaches the room.
import type {
  TriviaCategoryKey,
  TriviaDifficulty,
  TriviaOption,
  TriviaOptionId
} from '@singpulse/shared/types';

const OPENTDB_API = 'https://opentdb.com/api.php';
const OPENTDB_TOKEN = 'https://opentdb.com/api_token.php?command=request';
const REQUEST_TIMEOUT_MS = 5000;
// OpenTDB allows one api.php call per IP every 5 s (api_token.php is not limited)
const API_GATE_MS = 5100;
const OPTION_IDS: readonly TriviaOptionId[] = ['A', 'B', 'C', 'D'];

type QuestionDifficulty = 'easy' | 'medium' | 'hard';

export interface TriviaQuestion {
  text: string;
  categoryLabel: string;
  difficulty: QuestionDifficulty;
  options: TriviaOption[];
  correctOptionId: TriviaOptionId;
}

export interface TriviaQuestionSource {
  // Never rejects: failures degrade to the offline bank
  fetchBatch(category: TriviaCategoryKey, difficulty: TriviaDifficulty, amount: number): Promise<TriviaQuestion[]>;
}

interface TriviaServiceDeps {
  fetch?: typeof fetch;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const CATEGORY_IDS: Record<TriviaCategoryKey, readonly number[]> = {
  MUSIC: [12],
  FILM_TV: [11, 14],
  VIDEO_GAMES: [15],
  POP_CULTURE: [26, 9],
  PARTY_MIX: []
};

interface RawQuestion {
  category?: unknown;
  difficulty?: unknown;
  question?: unknown;
  correct_answer?: unknown;
  incorrect_answers?: unknown;
}

// Offline party bank: used whenever OpenTDB is unreachable, slow or rate limited
interface BankEntry {
  text: string;
  correct: string;
  incorrect: [string, string, string];
  difficulty: QuestionDifficulty;
  categoryLabel: string;
}

export const FALLBACK_BANK: readonly BankEntry[] = [
  { text: 'Which band released the album "Rumours" in 1977?', correct: 'Fleetwood Mac', incorrect: ['The Eagles', 'ABBA', 'Genesis'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'Who is known as the "King of Pop"?', correct: 'Michael Jackson', incorrect: ['Prince', 'Elvis Presley', 'Stevie Wonder'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'Which singer performed the 2012 hit "Gangnam Style"?', correct: 'PSY', incorrect: ['BTS', 'Rain', 'G-Dragon'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'What is the name of Beyonce\'s 2016 visual album?', correct: 'Lemonade', incorrect: ['Dangerously in Love', 'Renaissance', 'Homecoming'], difficulty: 'medium', categoryLabel: 'Music' },
  { text: 'Which group sang "Dancing Queen"?', correct: 'ABBA', incorrect: ['Bee Gees', 'Boney M.', 'The Supremes'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'Freddie Mercury was the lead singer of which band?', correct: 'Queen', incorrect: ['The Who', 'Led Zeppelin', 'Deep Purple'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'Which artist released the album "1989" in 2014?', correct: 'Taylor Swift', incorrect: ['Katy Perry', 'Lorde', 'Ariana Grande'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'What instrument does Yo-Yo Ma famously play?', correct: 'Cello', incorrect: ['Violin', 'Double bass', 'Viola'], difficulty: 'medium', categoryLabel: 'Music' },
  { text: 'Which Japanese city pop singer is known for the 1984 song "Plastic Love"?', correct: 'Mariya Takeuchi', incorrect: ['Miki Matsubara', 'Anri', 'Tatsuro Yamashita'], difficulty: 'hard', categoryLabel: 'Music' },
  { text: 'In which decade did disco peak in popularity?', correct: '1970s', incorrect: ['1950s', '1960s', '1990s'], difficulty: 'easy', categoryLabel: 'Music' },
  { text: 'Which film features the song "Let It Go"?', correct: 'Frozen', incorrect: ['Tangled', 'Moana', 'Brave'], difficulty: 'easy', categoryLabel: 'Film & TV' },
  { text: 'Which movie won the Oscar for Best Original Song with "Skyfall"?', correct: 'Skyfall', incorrect: ['Spectre', 'Casino Royale', 'Quantum of Solace'], difficulty: 'medium', categoryLabel: 'Film & TV' },
  { text: 'Who played Jack Dawson in "Titanic"?', correct: 'Leonardo DiCaprio', incorrect: ['Brad Pitt', 'Matt Damon', 'Johnny Depp'], difficulty: 'easy', categoryLabel: 'Film & TV' },
  { text: 'Which TV show features the coffee shop Central Perk?', correct: 'Friends', incorrect: ['Seinfeld', 'How I Met Your Mother', 'Frasier'], difficulty: 'easy', categoryLabel: 'Film & TV' },
  { text: 'In "Lost in Translation", which city is the story set in?', correct: 'Tokyo', incorrect: ['Seoul', 'Osaka', 'Hong Kong'], difficulty: 'medium', categoryLabel: 'Film & TV' },
  { text: 'Which video game character is a blue hedgehog?', correct: 'Sonic', incorrect: ['Crash', 'Rayman', 'Spyro'], difficulty: 'easy', categoryLabel: 'Games' },
  { text: 'What is the best-selling video game franchise of all time?', correct: 'Mario', incorrect: ['Pokemon', 'Call of Duty', 'Tetris'], difficulty: 'medium', categoryLabel: 'Games' },
  { text: 'Which pop star is known by the nickname "Mother Monster"?', correct: 'Lady Gaga', incorrect: ['Madonna', 'Nicki Minaj', 'Rihanna'], difficulty: 'medium', categoryLabel: 'Pop Culture' },
  { text: 'Which social app is known for short looping dance videos and is owned by ByteDance?', correct: 'TikTok', incorrect: ['Vine', 'Snapchat', 'Triller'], difficulty: 'easy', categoryLabel: 'Pop Culture' },
  { text: 'What does the "K" in K-pop stand for?', correct: 'Korean', incorrect: ['Kinetic', 'Karaoke', 'Key'], difficulty: 'easy', categoryLabel: 'Pop Culture' }
];

/** decodeURIComponent that never throws: a malformed sequence comes back untouched. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** Shuffles one correct and three wrong answers onto A-D, remembering which is right. */
export function buildQuestion(
  parts: { text: string; categoryLabel: string; difficulty: QuestionDifficulty; correct: string; incorrect: readonly string[] },
  random: () => number = Math.random
): TriviaQuestion {
  const answers = shuffle([{ text: parts.correct, right: true }, ...parts.incorrect.map((text) => ({ text, right: false }))], random);
  const options: TriviaOption[] = [];
  let correctOptionId: TriviaOptionId = 'A';
  for (const [i, answer] of answers.entries()) {
    const id = OPTION_IDS[i];
    if (!id) break;
    options.push({ id, text: answer.text });
    if (answer.right) correctOptionId = id;
  }
  return { text: parts.text, categoryLabel: parts.categoryLabel, difficulty: parts.difficulty, options, correctOptionId };
}

const asDifficulty = (value: unknown): QuestionDifficulty =>
  value === 'easy' || value === 'hard' ? value : 'medium';

/** Parses one url3986-encoded OpenTDB result; null when it is malformed. */
export function parseRawQuestion(raw: RawQuestion, random: () => number = Math.random): TriviaQuestion | null {
  if (typeof raw.question !== 'string' || typeof raw.correct_answer !== 'string') return null;
  if (!Array.isArray(raw.incorrect_answers) || raw.incorrect_answers.length !== 3) return null;
  if (!raw.incorrect_answers.every((a): a is string => typeof a === 'string')) return null;
  return buildQuestion(
    {
      text: safeDecode(raw.question),
      categoryLabel: typeof raw.category === 'string' ? safeDecode(raw.category) : 'Trivia',
      difficulty: asDifficulty(typeof raw.difficulty === 'string' ? safeDecode(raw.difficulty) : ''),
      correct: safeDecode(raw.correct_answer),
      incorrect: raw.incorrect_answers.map(safeDecode)
    },
    random
  );
}

/** Shuffled questions from the offline bank, preferring the requested category. */
export function fallbackBatch(
  category: TriviaCategoryKey,
  amount: number,
  random: () => number = Math.random
): TriviaQuestion[] {
  const label: Partial<Record<TriviaCategoryKey, string>> = {
    MUSIC: 'Music', FILM_TV: 'Film & TV', VIDEO_GAMES: 'Games', POP_CULTURE: 'Pop Culture'
  };
  const wanted = label[category];
  const preferred = FALLBACK_BANK.filter((e) => e.categoryLabel === wanted);
  const rest = FALLBACK_BANK.filter((e) => e.categoryLabel !== wanted);
  // Always lead with the closest matches, then pad from the whole bank (repeat only if amount > bank)
  const pool = [...shuffle(preferred, random), ...shuffle(rest, random)];
  const picked: BankEntry[] = [];
  for (let i = 0; i < amount; i++) picked.push(pool[i % pool.length] as BankEntry);
  return shuffle(picked, random).map((e) =>
    buildQuestion({ text: e.text, categoryLabel: e.categoryLabel, difficulty: e.difficulty, correct: e.correct, incorrect: e.incorrect }, random)
  );
}

type ApiOutcome = { kind: 'ok'; questions: TriviaQuestion[] } | { kind: 'code'; code: number } | { kind: 'fail' };

export class TriviaService implements TriviaQuestionSource {
  private fetchFn: typeof fetch;
  private random: () => number;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private token: string | null = null;
  // Earliest time the next api.php call may go out
  private nextApiCallAt = 0;

  constructor(deps: TriviaServiceDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  public async fetchBatch(category: TriviaCategoryKey, difficulty: TriviaDifficulty, amount: number): Promise<TriviaQuestion[]> {
    try {
      const questions = await this.fetchFromOpenTdb(category, difficulty, amount);
      if (questions.length >= amount) return questions.slice(0, amount);
      // Short batch: top up from the bank rather than shrink the game
      return [...questions, ...fallbackBatch(category, amount - questions.length, this.random)];
    } catch {
      return fallbackBatch(category, amount, this.random);
    }
  }

  private async fetchFromOpenTdb(category: TriviaCategoryKey, difficulty: TriviaDifficulty, amount: number): Promise<TriviaQuestion[]> {
    const ids = CATEGORY_IDS[category];
    const categoryId = ids.length ? ids[Math.floor(this.random() * ids.length)] : undefined;
    let withDifficulty = difficulty !== 'mixed';
    let refreshedToken = false;

    // At most: first try, one token refresh, one difficulty relaxation
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.ensureToken();
      const outcome = await this.callApi(amount, categoryId, withDifficulty ? difficulty : 'mixed', token);
      if (outcome.kind === 'ok') return outcome.questions;
      if (outcome.kind === 'fail') throw new Error('OpenTDB unavailable');
      if ((outcome.code === 3 || outcome.code === 4) && !refreshedToken) {
        refreshedToken = true;
        this.token = null;
        continue;
      }
      if (outcome.code === 1 && withDifficulty) {
        withDifficulty = false;
        continue;
      }
      throw new Error(`OpenTDB response_code ${outcome.code}`);
    }
    throw new Error('OpenTDB retries exhausted');
  }

  // Not rate limited by OpenTDB, so never gated; failure just means "no token"
  private async ensureToken(): Promise<string | null> {
    if (this.token) return this.token;
    try {
      const res = await this.fetchFn(OPENTDB_TOKEN, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = (await res.json()) as { response_code?: unknown; token?: unknown };
      if (body.response_code === 0 && typeof body.token === 'string' && body.token) this.token = body.token;
    } catch {
      // A missing token only means questions may repeat across games
    }
    return this.token;
  }

  private async callApi(
    amount: number,
    categoryId: number | undefined,
    difficulty: TriviaDifficulty,
    token: string | null
  ): Promise<ApiOutcome> {
    const wait = this.nextApiCallAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextApiCallAt = this.now() + API_GATE_MS;

    const params = new URLSearchParams({ amount: String(amount), type: 'multiple', encode: 'url3986' });
    if (categoryId !== undefined) params.set('category', String(categoryId));
    if (difficulty !== 'mixed') params.set('difficulty', difficulty);
    if (token) params.set('token', token);

    try {
      const res = await this.fetchFn(`${OPENTDB_API}?${params}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return { kind: 'fail' };
      const body = (await res.json()) as { response_code?: unknown; results?: unknown };
      if (typeof body.response_code !== 'number') return { kind: 'fail' };
      if (body.response_code !== 0) return { kind: 'code', code: body.response_code };
      if (!Array.isArray(body.results)) return { kind: 'fail' };
      const questions = (body.results as RawQuestion[])
        .map((raw) => parseRawQuestion(raw, this.random))
        .filter((q): q is TriviaQuestion => q !== null);
      return questions.length ? { kind: 'ok', questions } : { kind: 'fail' };
    } catch {
      return { kind: 'fail' };
    }
  }
}
