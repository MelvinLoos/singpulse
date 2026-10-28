<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Check, LogOut, Minimize2, Play, Square, X } from 'lucide-vue-next';
import type { TriviaOptionId } from '@singpulse/shared/types';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { TRIVIA_QUESTION_MS, categoryLabel, rankOf, ranked } from '../lib/trivia.ts';

const ICON_STROKE = 1.75;

const store = useKaraokeStore();
const root = ref<HTMLElement | null>(null);
const status = ref('');
const busy = ref(false);

// Callers mount this only while a game exists, so the assertion is safe
const game = computed(() => store.activeTrivia!);
const me = computed(() => store.myTriviaPlayer);
const phase = computed(() => game.value.phase);

const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 100);
  void nextTick(() => root.value?.focus());
});
onUnmounted(() => {
  if (tick) clearInterval(tick);
});

// Move focus to the sheet whenever the phase changes so screen readers re-announce it
watch(phase, () => void nextTick(() => root.value?.focus()));

const remainingMs = computed(() => Math.max(0, (game.value.phaseEndsAt ?? 0) - now.value));
const barScale = computed(() => (phase.value === 'QUESTION' ? Math.min(1, remainingMs.value / TRIVIA_QUESTION_MS) : 0));
const seconds = computed(() => Math.ceil(remainingMs.value / 1000));

const rank = computed(() => rankOf(game.value, store.myTriviaPlayer?.playerId ?? ''));
const total = computed(() => game.value.players.length);
const picked = computed(() => store.myTriviaAnswer);
const locked = computed(() => picked.value !== null || me.value?.hasAnsweredCurrent === true || remainingMs.value === 0);
const waitingOn = computed(() => Math.max(0, total.value - game.value.lockedInCount));

const resultLine = computed(() => {
  const p = me.value;
  if (!p || p.lastAnswerCorrect !== true) return null;
  const streak = p.streak >= 2 ? ` // ${p.streak}x STREAK` : '';
  return `CORRECT (+${p.lastPointsEarned} PTS${streak})`;
});

const difficultyTone: Record<string, string> = {
  easy: 'text-acid-lime',
  medium: 'text-vinyl-amber',
  hard: 'text-neon-coral'
};

async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  status.value = '';
  try {
    await action();
  } catch {
    status.value = failure;
  } finally {
    busy.value = false;
  }
}

function answer(id: TriviaOptionId): void {
  if (locked.value || phase.value !== 'QUESTION') return;
  navigator.vibrate?.(20);
  status.value = '';
  store.submitTriviaAnswer(id).catch(() => (status.value = 'ANSWER NOT SENT // TAP AGAIN'));
}

const start = () => run(() => store.startTriviaGame(), 'COULD NOT START // TRY AGAIN');
const end = () => run(() => store.stopTriviaGame(), 'COULD NOT END // TRY AGAIN');
const leave = () => run(() => store.leaveTrivia(), 'COULD NOT LEAVE // TRY AGAIN');
const browse = () => (store.triviaMinimized = true);

function padClass(id: TriviaOptionId): string {
  if (phase.value === 'REVEAL') {
    if (id === game.value.correctOptionId) return 'border-acid-lime bg-acid-lime text-obsidian';
    if (id === picked.value) return 'border-neon-coral bg-surface text-white/70 opacity-80';
    return 'border-white/12 bg-surface text-white/50 opacity-50';
  }
  if (picked.value === id) return 'border-acid-lime bg-acid-lime text-obsidian';
  if (locked.value) return 'border-white/12 bg-surface text-white/50 opacity-50';
  return 'border-white/25 bg-surface-elevated text-white active:translate-y-px active:border-acid-lime';
}
</script>

<template>
  <div
    ref="root"
    class="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-obsidian px-safe pt-safe pb-safe focus:outline-none"
    role="dialog"
    aria-modal="true"
    aria-labelledby="trivia-title"
    tabindex="-1"
  >
    <header class="flex flex-wrap items-center justify-between gap-2">
      <p id="trivia-title" class="font-mono text-[11px] font-bold tracking-widest text-acid-lime uppercase">
        TRIVIA BLITZ // {{ categoryLabel(game.category) }}
      </p>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-11 items-center gap-1.5 rounded-key border border-white/25 px-3 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
          @click="browse"
        >
          <Minimize2 class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Browse songs
        </button>
        <button
          v-if="store.isAdmin"
          type="button"
          class="flex h-11 items-center gap-1.5 rounded-key border border-neon-coral bg-neon-coral px-3 font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px disabled:opacity-50"
          :disabled="busy"
          aria-label="End trivia for everyone"
          @click="end"
        >
          <Square class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> End
        </button>
        <button
          type="button"
          class="flex h-11 items-center gap-1.5 rounded-key border border-white/25 px-3 font-mono text-[11px] font-bold tracking-widest text-white/80 uppercase active:translate-y-px active:bg-surface-elevated disabled:opacity-50"
          :disabled="busy"
          @click="leave"
        >
          <LogOut class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Leave
        </button>
      </div>
    </header>

    <!-- LOBBY -->
    <main v-if="phase === 'LOBBY'" class="flex flex-1 flex-col justify-center py-6">
      <p class="font-display text-4xl leading-[0.9] font-extrabold tracking-tighter uppercase">
        You're in<span class="text-acid-lime"> // </span>waiting for host
      </p>
      <p class="mt-3 font-mono text-[11px] tracking-widest text-white/70 uppercase">
        {{ game.totalRounds }} QUESTIONS // {{ total }} PLAYERS
      </p>
      <ul class="mt-5 flex flex-wrap gap-2" aria-label="Players">
        <li
          v-for="p in game.players"
          :key="p.playerId"
          class="rounded-full border px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase"
          :class="p.playerId === me?.playerId ? 'border-acid-lime text-acid-lime' : 'border-white/25 text-white/80'"
        >
          {{ p.name }}
        </li>
      </ul>
      <button
        v-if="store.isAdmin"
        type="button"
        class="mt-8 flex min-h-20 w-full items-center justify-center gap-3 rounded-key bg-acid-lime px-4 font-display text-2xl font-extrabold tracking-tighter text-obsidian uppercase active:translate-y-px disabled:opacity-50"
        :disabled="busy || total === 0"
        @click="start"
      >
        <Play class="size-6" :stroke-width="2" aria-hidden="true" />
        Start trivia blitz ({{ total }} {{ total === 1 ? 'player' : 'players' }})
      </button>
    </main>

    <!-- QUESTION + REVEAL -->
    <main v-else-if="phase === 'QUESTION' || phase === 'REVEAL'" class="flex flex-1 flex-col py-4">
      <p class="flex items-center justify-between gap-3 font-mono text-[11px] tracking-widest uppercase">
        <span class="text-white">ROUND {{ game.roundIndex + 1 }}/{{ game.totalRounds }}</span>
        <span class="flex items-center gap-1.5" :class="difficultyTone[game.questionDifficulty ?? 'medium']">
          <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
          {{ game.questionDifficulty }}
        </span>
        <span class="text-white/70 tabular-nums">{{ phase === 'QUESTION' ? `00:${String(seconds).padStart(2, '0')}` : 'REVEAL' }}</span>
      </p>
      <div class="mt-2 h-1.5 bg-white/12" aria-hidden="true">
        <div class="h-full origin-left bg-acid-lime" :style="{ transform: `scaleX(${barScale})` }" />
      </div>

      <h2 class="mt-5 text-xl leading-snug font-semibold">{{ game.questionText }}</h2>

      <div class="mt-5 grid flex-1 grid-cols-2 grid-rows-2 gap-2" role="group" aria-label="Answers">
        <button
          v-for="o in game.options"
          :key="o.id"
          type="button"
          class="flex min-h-28 flex-col items-start justify-between gap-2 rounded-key border p-3 text-left transition-colors duration-150 motion-reduce:transition-none"
          :class="padClass(o.id)"
          :disabled="locked || phase !== 'QUESTION'"
          :aria-pressed="picked === o.id"
          @click="answer(o.id)"
        >
          <span class="font-mono text-[11px] font-bold tracking-widest">{{ o.id }}</span>
          <span class="text-base leading-tight font-semibold break-words">{{ o.text }}</span>
        </button>
      </div>

      <div class="mt-5 min-h-16" role="status">
        <template v-if="phase === 'QUESTION'">
          <p v-if="locked" class="flex items-center gap-2 font-mono text-[11px] font-bold tracking-widest text-acid-lime uppercase">
            <Check class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" />
            ANSWER LOCKED // WAITING FOR {{ waitingOn }} {{ waitingOn === 1 ? 'OTHER' : 'OTHERS' }}
          </p>
          <p v-else class="font-mono text-[11px] tracking-widest text-white/70 uppercase">TAP A PAD // FASTER = MORE POINTS</p>
        </template>
        <template v-else>
          <p v-if="resultLine" class="font-display text-2xl leading-none font-extrabold tracking-tighter text-acid-lime uppercase">{{ resultLine }}</p>
          <p v-else-if="me" class="flex items-center gap-2 font-display text-2xl leading-none font-extrabold tracking-tighter text-neon-coral uppercase">
            <X class="size-6" :stroke-width="2" aria-hidden="true" /> {{ me.lastAnswerCorrect === null ? 'No answer' : 'Missed it' }}
          </p>
          <p v-if="me" class="mt-2 font-mono text-[11px] tracking-widest text-white/80 uppercase">
            RANK #{{ rank }} OF {{ total }} // {{ me.score }} PTS
          </p>
        </template>
      </div>
    </main>

    <!-- PODIUM -->
    <main v-else class="flex flex-1 flex-col justify-center py-6">
      <p class="font-mono text-[11px] tracking-widest text-white/70 uppercase">FINAL STANDINGS</p>
      <p class="mt-2 font-display text-7xl leading-[0.85] font-extrabold tracking-tighter text-acid-lime uppercase">
        #{{ rank || '-' }}
      </p>
      <p class="mt-3 font-mono text-sm tracking-widest uppercase">
        {{ me?.score ?? 0 }} PTS // OF {{ total }} {{ total === 1 ? 'PLAYER' : 'PLAYERS' }}
      </p>
      <ol class="mt-5 space-y-1">
        <li
          v-for="(p, i) in ranked(game).slice(0, 3)"
          :key="p.playerId"
          class="flex items-center justify-between border-b border-white/12 py-2 font-mono text-[11px] tracking-widest uppercase"
        >
          <span class="truncate"><span class="text-acid-lime">0{{ i + 1 }}</span> {{ p.name }}</span>
          <span class="tabular-nums">{{ p.score }}</span>
        </li>
      </ol>
      <button
        type="button"
        class="mt-8 min-h-14 w-full rounded-key bg-acid-lime px-4 font-mono text-sm font-bold tracking-widest text-obsidian uppercase active:translate-y-px"
        @click="browse"
      >
        Back to karaoke
      </button>
    </main>

    <p class="min-h-6 font-mono text-[11px] tracking-widest text-neon-coral uppercase" role="alert">{{ status }}</p>
  </div>
</template>
