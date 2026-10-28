import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_BANK, TriviaService, buildQuestion, safeDecode, shuffle } from '../src/triviaService.ts';

function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const enc = encodeURIComponent;

function rawQuestion(n: number) {
  return {
    category: enc('Entertainment: Music'),
    difficulty: 'easy',
    question: enc(`Who sang "Song ${n}" & more?`),
    correct_answer: enc('Beyoncé'),
    incorrect_answers: [enc("Rock 'n' Roll"), enc('A&B'), enc('Nope')]
  };
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

interface Harness {
  service: TriviaService;
  calls: string[];
  sleeps: number[];
}

function harness(handler: (url: URL, call: number) => Promise<Response>): Harness {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const service = new TriviaService({
    fetch: ((input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      return handler(url, calls.length);
    }) as typeof fetch,
    random: seeded(),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    }
  });
  return { service, calls, sleeps };
}

const okApi = (results: unknown[]) => json({ response_code: 0, results });
const tokenOk = () => json({ response_code: 0, token: 'tok123' });
const isToken = (url: URL) => url.pathname.endsWith('api_token.php');

describe('triviaService helpers', () => {
  it('decodes url3986 without leaking HTML entities', () => {
    assert.equal(safeDecode(enc('Who sang "Halo" & more?')), 'Who sang "Halo" & more?');
    assert.equal(safeDecode('Beyonc%C3%A9%E2%80%99s'), 'Beyoncé’s');
  });

  it('returns a malformed sequence untouched instead of throwing', () => {
    assert.equal(safeDecode('100%E0%A4%A'), '100%E0%A4%A');
  });

  it('shuffles into a permutation, deterministically for a seed', () => {
    const items = [1, 2, 3, 4, 5, 6];
    const a = shuffle(items, seeded(7));
    assert.deepEqual(a.toSorted(), items);
    assert.deepEqual(a, shuffle(items, seeded(7)));
    assert.deepEqual(items, [1, 2, 3, 4, 5, 6]);
  });

  it('maps shuffled answers onto A-D and tracks the right one', () => {
    for (let seed = 1; seed < 20; seed++) {
      const q = buildQuestion(
        { text: 'q', categoryLabel: 'c', difficulty: 'easy', correct: 'RIGHT', incorrect: ['x', 'y', 'z'] },
        seeded(seed)
      );
      assert.deepEqual(q.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
      assert.equal(q.options.find((o) => o.id === q.correctOptionId)?.text, 'RIGHT');
    }
  });

  it('ships a well-formed offline bank of at least 15 questions', () => {
    assert.ok(FALLBACK_BANK.length >= 15);
    for (const entry of FALLBACK_BANK) {
      assert.equal(entry.incorrect.length, 3);
      assert.equal(new Set([entry.correct, ...entry.incorrect]).size, 4);
    }
  });
});

describe('TriviaService', () => {
  it('fetches the whole game in one decoded api.php call, with a token', async () => {
    const h = harness((url) => (isToken(url) ? tokenOk() : okApi([1, 2, 3, 4, 5].map(rawQuestion))));
    const questions = await h.service.fetchBatch('MUSIC', 'easy', 5);

    assert.equal(questions.length, 5);
    assert.equal(h.calls.filter((c) => c.includes('/api.php')).length, 1);
    const api = new URL(`https://x${h.calls.find((c) => c.includes('/api.php'))}`);
    assert.equal(api.searchParams.get('amount'), '5');
    assert.equal(api.searchParams.get('type'), 'multiple');
    assert.equal(api.searchParams.get('encode'), 'url3986');
    assert.equal(api.searchParams.get('category'), '12');
    assert.equal(api.searchParams.get('difficulty'), 'easy');
    assert.equal(api.searchParams.get('token'), 'tok123');
    assert.match(questions[0]?.text ?? '', /^Who sang "Song 1" & more\?$/);
    assert.ok(questions[0]?.options.some((o) => o.text === "Rock 'n' Roll"));
    assert.deepEqual(h.sleeps, []); // token then api.php runs back to back
  });

  it('omits difficulty for mixed and category for the party mix', async () => {
    const h = harness((url) => (isToken(url) ? tokenOk() : okApi([rawQuestion(1)])));
    await h.service.fetchBatch('PARTY_MIX', 'mixed', 1);
    const api = new URL(`https://x${h.calls.find((c) => c.includes('/api.php'))}`);
    assert.equal(api.searchParams.has('difficulty'), false);
    assert.equal(api.searchParams.has('category'), false);
  });

  it('falls back to the bank when fetch rejects', async () => {
    const h = harness(() => Promise.reject(new TypeError('network down')));
    const questions = await h.service.fetchBatch('MUSIC', 'mixed', 5);
    assert.equal(questions.length, 5);
    assert.ok(questions.every((q) => q.options.length === 4));
  });

  it('falls back on a timeout abort', async () => {
    const h = harness(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    assert.equal((await h.service.fetchBatch('POP_CULTURE', 'mixed', 10)).length, 10);
  });

  it('falls back on rate-limit code 5', async () => {
    const h = harness((url) => (isToken(url) ? tokenOk() : json({ response_code: 5, results: [] })));
    const questions = await h.service.fetchBatch('MUSIC', 'mixed', 5);
    assert.equal(questions.length, 5);
    assert.equal(h.calls.filter((c) => c.includes('/api.php')).length, 1);
  });

  for (const code of [3, 4]) {
    it(`resets the token and retries once on code ${code}`, async () => {
      let apiCalls = 0;
      let tokens = 0;
      const h = harness((url) => {
        if (isToken(url)) {
          tokens += 1;
          return json({ response_code: 0, token: `tok${tokens}` });
        }
        apiCalls += 1;
        return apiCalls === 1 ? json({ response_code: code, results: [] }) : okApi([rawQuestion(1), rawQuestion(2)]);
      });
      const questions = await h.service.fetchBatch('MUSIC', 'mixed', 2);

      assert.equal(tokens, 2);
      assert.equal(apiCalls, 2);
      assert.equal(questions.length, 2);
      assert.ok(h.calls.at(-1)?.includes('token=tok2'));
      // Only the second api.php call waits for the gate; token calls never do
      assert.equal(h.sleeps.length, 1);
      assert.ok((h.sleeps[0] ?? 0) >= 5000);
    });
  }

  it('falls back after a second token failure', async () => {
    const h = harness((url) => (isToken(url) ? tokenOk() : json({ response_code: 4, results: [] })));
    assert.equal((await h.service.fetchBatch('MUSIC', 'mixed', 5)).length, 5);
    assert.equal(h.calls.filter((c) => c.includes('/api.php')).length, 2);
  });

  it('drops the difficulty filter once when OpenTDB has too few questions', async () => {
    let apiCalls = 0;
    const h = harness((url) => {
      if (isToken(url)) return tokenOk();
      apiCalls += 1;
      return apiCalls === 1 ? json({ response_code: 1, results: [] }) : okApi([rawQuestion(1)]);
    });
    await h.service.fetchBatch('MUSIC', 'hard', 1);
    assert.ok(h.calls.at(-1) && !h.calls.at(-1)?.includes('difficulty='));
  });

  it('still works without a token and tops up a short batch from the bank', async () => {
    const h = harness((url) => (isToken(url) ? Promise.reject(new Error('no token')) : okApi([rawQuestion(1)])));
    const questions = await h.service.fetchBatch('MUSIC', 'mixed', 5);
    assert.equal(questions.length, 5);
    assert.ok(!h.calls.some((c) => c.includes('token=')));
  });
});
