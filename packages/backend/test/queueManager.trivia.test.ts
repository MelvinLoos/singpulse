import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { QueueItem, TriviaGameState } from '@singpulse/shared/types';
import type { TriviaQuestion, TriviaQuestionSource } from '../src/triviaService.ts';

const downloads = new Map<string, (mediaUrl: string) => void>();
mock.module(new URL('../src/ytdlp.ts', import.meta.url).href, {
  namedExports: {
    downloadKaraokeVideo: (videoId: string) =>
      new Promise<string>((resolve) => {
        downloads.set(videoId, resolve);
      })
  }
});

const { QueueManager } = await import('../src/queueManager.ts');

function question(n: number): TriviaQuestion {
  return {
    text: `Question ${n}?`,
    categoryLabel: 'Music',
    difficulty: 'easy',
    options: [
      { id: 'A', text: 'Right' },
      { id: 'B', text: 'Wrong 1' },
      { id: 'C', text: 'Wrong 2' },
      { id: 'D', text: 'Wrong 3' }
    ],
    correctOptionId: 'A'
  };
}

const source: TriviaQuestionSource = {
  fetchBatch: async (_category, _difficulty, amount) => Array.from({ length: amount }, (_, i) => question(i))
};

const track = (videoId: string, singer: string): Omit<QueueItem, 'id' | 'status'> =>
  ({ videoId, singer, title: `Track ${videoId}`, duration: 180, thumbnail: '' });

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const PLAYER_A = 'player-aaaaaaaa';
const PLAYER_B = 'player-bbbbbbbb';

type Manager = InstanceType<typeof QueueManager>;

async function readySongDuringTrivia(manager: Manager) {
  manager.openTriviaLobby('MUSIC', 'mixed', 5);
  manager.joinTrivia(PLAYER_A, 'Alice');
  manager.enqueue(track('aaaaaaaaaa1', 'Bob'));
  assert.equal(manager.getState().queue[0]?.status, 'downloading'); // downloads still run
  downloads.get('aaaaaaaaaa1')?.('/media/a.mp4');
  await flush();
}

describe('QueueManager trivia blitz', () => {
  let manager: InstanceType<typeof QueueManager>;
  const trivia = (): TriviaGameState => {
    const t = manager.getState().activeTrivia;
    assert.ok(t, 'expected an active trivia game');
    return t;
  };
  const lockedFromRoster = () => trivia().players.filter((p) => p.hasAnsweredCurrent).length;

  async function startGame(rounds = 5, players = [PLAYER_A, PLAYER_B]) {
    assert.equal(manager.openTriviaLobby('MUSIC', 'mixed', rounds), 'ok');
    players.forEach((id, i) => manager.joinTrivia(id, `Player ${i}`));
    assert.equal(await manager.startTriviaGame(), 'ok');
    return players;
  }

  beforeEach(() => {
    downloads.clear();
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    manager = new QueueManager('abc123', 'https://sing.example.com', () => {}, () => [], source);
  });

  afterEach(() => mock.timers.reset());

  describe('lobby and roster', () => {
    it('refuses to open while a song is playing', async () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      downloads.get('aaaaaaaaaa1')?.('/media/a.mp4');
      await flush();
      assert.ok(manager.getState().currentSong);
      assert.equal(manager.openTriviaLobby('MUSIC', 'mixed', 5), 'conflict');
      assert.equal(manager.getState().activeTrivia, null);
    });

    it('refuses to open during a crowd vote or while a game is already open', async () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Alice'));
      downloads.get('aaaaaaaaaa1')?.('/media/a.mp4');
      await flush();
      const id = manager.getState().currentSong?.id ?? '';
      manager.handleSongEnded(id);
      assert.ok(manager.getState().activeVote);
      assert.equal(manager.openTriviaLobby('MUSIC', 'mixed', 5), 'conflict');

      manager.skipVote();
      assert.equal(manager.openTriviaLobby('MUSIC', 'mixed', 5), 'ok');
      assert.equal(manager.openTriviaLobby('FILM_TV', 'easy', 10), 'conflict');
    });

    it('never exposes the private voterId in the broadcast state', async () => {
      await startGame();
      const wire = JSON.stringify(manager.getState().activeTrivia);
      assert.ok(!wire.includes(PLAYER_A) && !wire.includes(PLAYER_B));
      // A broadcast id cannot be replayed as a credential
      assert.equal(manager.leaveTrivia(manager.triviaPlayerId(PLAYER_A)), 'not-found');
      assert.equal(trivia().players.length, 2);
    });

    it('dedupes joins by playerId and updates the name', () => {
      manager.openTriviaLobby('MUSIC', 'mixed', 5);
      manager.joinTrivia(PLAYER_A, 'Alice');
      manager.joinTrivia(PLAYER_A, 'Alicia');
      assert.deepEqual(trivia().players.map((p) => p.name), ['Alicia']);
    });

    it('will not start without players', async () => {
      manager.openTriviaLobby('MUSIC', 'mixed', 5);
      assert.equal(await manager.startTriviaGame(), 'no-players');
      assert.equal(trivia().phase, 'LOBBY');
    });

    it('lets a latecomer join mid-question', async () => {
      await startGame();
      assert.equal(manager.joinTrivia('player-cccccccc', 'Late'), 'ok');
      assert.equal(trivia().players.length, 3);
      assert.equal(trivia().lockedInCount, 0);
    });

    it('a leave that leaves everyone answered triggers the reveal', async () => {
      await startGame();
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      assert.equal(trivia().phase, 'QUESTION');
      manager.leaveTrivia(PLAYER_B);
      assert.equal(trivia().phase, 'REVEAL');
    });

    it('ends the game when the last player leaves mid-game, but not in the lobby', async () => {
      manager.openTriviaLobby('MUSIC', 'mixed', 5);
      manager.joinTrivia(PLAYER_A, 'Alice');
      manager.leaveTrivia(PLAYER_A);
      assert.ok(manager.getState().activeTrivia);

      manager.joinTrivia(PLAYER_A, 'Alice');
      await manager.startTriviaGame();
      manager.leaveTrivia(PLAYER_A);
      assert.equal(manager.getState().activeTrivia, null);
    });
  });

  describe('rounds and scoring', () => {
    it('hides the correct option and results until the reveal', async () => {
      await startGame();
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      const t = trivia();
      assert.equal(t.phase, 'QUESTION');
      assert.equal(t.correctOptionId, undefined);
      assert.equal(t.players.find((p) => p.playerId === manager.triviaPlayerId(PLAYER_A))?.score, 0);
      assert.equal(t.players.find((p) => p.playerId === manager.triviaPlayerId(PLAYER_A))?.lastAnswerCorrect, null);
      assert.equal(t.lockedInCount, 1);
    });

    it('short-circuits to REVEAL once every player has locked in', async () => {
      await startGame();
      manager.submitTriviaAnswer(PLAYER_A, 'B');
      assert.equal(trivia().phase, 'QUESTION');
      manager.submitTriviaAnswer(PLAYER_B, 'A');
      const t = trivia();
      assert.equal(t.phase, 'REVEAL');
      assert.equal(t.correctOptionId, 'A');
      assert.equal(t.roundFastestPlayerName, 'Player 1');
    });

    it('keeps lockedInCount equal to the roster after submits, joins and leaves', async () => {
      await startGame();
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      assert.equal(trivia().lockedInCount, lockedFromRoster());
      manager.joinTrivia('player-cccccccc', 'Late');
      assert.equal(trivia().lockedInCount, lockedFromRoster());
      manager.leaveTrivia(PLAYER_A);
      assert.equal(trivia().lockedInCount, lockedFromRoster());
      assert.equal(trivia().lockedInCount, 0);
    });

    it('scores 500 + speed + streak and ignores duplicate taps', async () => {
      await startGame(5, [PLAYER_A, PLAYER_B]);
      manager.submitTriviaAnswer(PLAYER_A, 'A'); // t=0: full speed bonus
      mock.timers.tick(7000);
      manager.submitTriviaAnswer(PLAYER_B, 'A'); // half the timer left
      manager.submitTriviaAnswer(PLAYER_B, 'B'); // duplicate after reveal is refused

      const players = trivia().players;
      assert.equal(players.find((p) => p.playerId === manager.triviaPlayerId(PLAYER_A))?.lastPointsEarned, 1000);
      assert.equal(players.find((p) => p.playerId === manager.triviaPlayerId(PLAYER_B))?.lastPointsEarned, 750);
      assert.equal(players[0]?.playerId, manager.triviaPlayerId(PLAYER_A)); // sorted by score
    });

    it('adds +100 per streak step capped at +300, and resets on a miss', async () => {
      await startGame(10, [PLAYER_A]);
      const earned: number[] = [];
      for (let round = 0; round < 6; round++) {
        manager.submitTriviaAnswer(PLAYER_A, round === 5 ? 'B' : 'A');
        earned.push(trivia().players[0]?.lastPointsEarned ?? -1);
        mock.timers.tick(4500); // next question
      }
      assert.deepEqual(earned, [1000, 1100, 1200, 1300, 1300, 0]);
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      assert.equal(trivia().players[0]?.lastPointsEarned, 1000); // streak restarted
      assert.equal(trivia().players[0]?.streak, 1);
    });

    it('times out an unanswered question and resets that streak', async () => {
      await startGame(5, [PLAYER_A]);
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      mock.timers.tick(4500);
      assert.equal(trivia().roundIndex, 1);
      mock.timers.tick(14000);
      const t = trivia();
      assert.equal(t.phase, 'REVEAL');
      assert.equal(t.players[0]?.streak, 0);
      assert.equal(t.players[0]?.lastAnswerCorrect, null);
    });

    it('auto-enrolls a late answerer when a name is supplied, but not past 50 players', async () => {
      await startGame(5, [PLAYER_A]);
      assert.equal(manager.submitTriviaAnswer('player-cccccccc', 'A'), 'not-found');
      assert.equal(manager.submitTriviaAnswer('player-cccccccc', 'A', 'Late'), 'ok');
      assert.equal(trivia().players.length, 2);

      manager.openTriviaLobby('MUSIC', 'mixed', 5); // refused, a game is live
      manager.stopTrivia();
      manager.openTriviaLobby('MUSIC', 'mixed', 5);
      for (let i = 0; i < 50; i++) manager.joinTrivia(`player-${String(i).padStart(8, '0')}`, `P${i}`);
      await manager.startTriviaGame();
      assert.equal(manager.submitTriviaAnswer('player-overflow', 'A', 'Extra'), 'conflict');
      assert.equal(trivia().players.length, 50);
      assert.equal(trivia().lockedInCount, 0);
    });

    it('walks REVEAL to the next question, then PODIUM, then clears', async () => {
      await startGame(2, [PLAYER_A]);
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      assert.equal(trivia().phase, 'REVEAL');
      mock.timers.tick(4500);
      assert.equal(trivia().phase, 'QUESTION');
      assert.equal(trivia().roundIndex, 1);
      assert.equal(trivia().correctOptionId, undefined);
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      mock.timers.tick(4500);
      assert.equal(trivia().phase, 'PODIUM');
      mock.timers.tick(12000);
      assert.equal(manager.getState().activeTrivia, null);
    });
  });

  describe('karaoke queue during trivia', () => {
    it('holds a ready song back while trivia runs', async () => {
      await readySongDuringTrivia(manager);
      const state = manager.getState();
      assert.equal(state.currentSong, null);
      assert.equal(state.queue[0]?.status, 'ready');
    });

    it('starts it when the host stops trivia', async () => {
      await readySongDuringTrivia(manager);
      assert.equal(manager.stopTrivia(), 'ok');
      assert.equal(manager.getState().currentSong?.videoId, 'aaaaaaaaaa1');
      assert.equal(manager.getState().activeTrivia, null);
    });

    it('starts it after the podium ends', async () => {
      manager.enqueue(track('aaaaaaaaaa1', 'Bob'));
      await startGame(1, [PLAYER_A]);
      downloads.get('aaaaaaaaaa1')?.('/media/a.mp4');
      await flush();
      manager.submitTriviaAnswer(PLAYER_A, 'A');
      mock.timers.tick(4500);
      assert.equal(trivia().phase, 'PODIUM');
      assert.equal(manager.getState().currentSong, null);
      mock.timers.tick(12000);
      assert.equal(manager.getState().currentSong?.videoId, 'aaaaaaaaaa1');
    });
  });
});
