<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import QrcodeVue from 'qrcode.vue';
import { Crown, Flame, Zap } from 'lucide-vue-next';
import type { TriviaGameState } from '@singpulse/shared/types';
import SegmentBar from './SegmentBar.vue';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { TRIVIA_QUESTION_MS, categoryLabel, pad2, ranked } from '../lib/trivia.ts';
import { triviaSounds } from '../lib/triviaSounds.ts';

const MAX_LOCK_PILLS = 12;
const ICON_STROKE = 1.75;

const props = defineProps<{ game: TriviaGameState }>();
const store = useKaraokeStore();

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 250);
});

onUnmounted(() => {
  if (clock) clearInterval(clock);
  triviaSounds.dispose();
});

const phase = computed(() => props.game.phase);
const standings = computed(() => ranked(props.game));
const remainingMs = computed(() => Math.max(0, (props.game.phaseEndsAt ?? 0) - now.value));
const fill = computed(() => (phase.value === 'QUESTION' ? Math.min(1, remainingMs.value / TRIVIA_QUESTION_MS) : 0));
const seconds = computed(() => Math.ceil(remainingMs.value / 1000));
const lockPills = computed(() => props.game.players.slice(0, MAX_LOCK_PILLS));
const hiddenPlayers = computed(() => Math.max(0, props.game.players.length - MAX_LOCK_PILLS));
const podium = computed(() => {
  const [first, second, third] = standings.value;
  return [
    { place: 2, player: second, height: 'h-[13rem]', delay: '300ms' },
    { place: 1, player: first, height: 'h-[18rem]', delay: '0ms' },
    { place: 3, player: third, height: 'h-[10rem]', delay: '600ms' }
  ];
});

const difficultyTone: Record<string, string> = {
  easy: 'text-acid-lime',
  medium: 'text-vinyl-amber',
  hard: 'text-neon-coral'
};

// Sound cues: skipped for the first render, so a TV reconnecting mid-game stays quiet
watch(() => props.game.players.length, (n, prev) => n > prev && triviaSounds.blip());
watch(
  () => props.game.lockedInCount,
  (n, prev) => phase.value === 'QUESTION' && n > prev && triviaSounds.blip()
);
watch(seconds, (s) => phase.value === 'QUESTION' && s >= 1 && s <= 3 && triviaSounds.tick());
watch(phase, (next, prev) => {
  if (next === 'REVEAL') triviaSounds.chime();
  else if (next === 'PODIUM') triviaSounds.fanfare();
  else if (next === 'QUESTION' && prev === 'LOBBY') triviaSounds.blip();
});
</script>

<template>
  <div class="absolute inset-0 z-20 flex flex-col overflow-hidden bg-obsidian px-[4rem] py-[2.25rem]" aria-live="polite">
    <div class="pointer-events-none absolute inset-0 bg-grid-lines" aria-hidden="true" />

    <!-- TOP BAR -->
    <header class="relative">
      <p class="flex items-center justify-between gap-6 font-mono text-[1.25rem] tracking-widest uppercase">
        <template v-if="phase === 'LOBBY'">
          <span class="text-acid-lime">TRIVIA BLITZ // LOBBY</span>
          <span class="text-white/70">{{ pad2(game.players.length) }} PLAYERS</span>
        </template>
        <template v-else-if="phase === 'PODIUM'">
          <span class="text-acid-lime">TRIVIA BLITZ // RESULTS</span>
        </template>
        <template v-else>
          <span class="text-white">ROUND {{ pad2(game.roundIndex + 1) }} / {{ pad2(game.totalRounds) }}</span>
          <span class="flex items-center gap-4">
            <span class="rounded-full border border-white/25 px-5 py-1 text-white/85">{{ game.questionCategoryLabel }}</span>
            <span class="flex items-center gap-2 rounded-full border border-current px-5 py-1" :class="difficultyTone[game.questionDifficulty ?? 'medium']">
              <span class="size-[0.6rem] rounded-full bg-current" aria-hidden="true" />
              {{ game.questionDifficulty }}
            </span>
            <span class="w-[5rem] text-right text-white/85 tabular-nums">
              {{ phase === 'QUESTION' ? `00:${pad2(seconds)}` : 'REVEAL' }}
            </span>
          </span>
        </template>
      </p>
      <SegmentBar
        v-if="phase === 'QUESTION' || phase === 'REVEAL'"
        class="mt-4 h-[0.9rem]"
        :fill="fill"
        tone="ready"
        :segments="20"
        label="Time remaining"
      />
    </header>

    <!-- STAGE -->
    <main class="relative flex min-h-0 flex-1 flex-col justify-center">
      <!-- LOBBY -->
      <template v-if="phase === 'LOBBY'">
        <h1 class="font-display text-[5.5rem] leading-[1] font-extrabold tracking-tighter uppercase">
          Trivia Blitz <span class="text-acid-lime">//</span><br />Join on your phone now
        </h1>
        <p class="mt-5 flex gap-4 font-mono text-[1.25rem] tracking-widest uppercase">
          <span class="rounded-full border border-acid-lime px-5 py-1 text-acid-lime">{{ categoryLabel(game.category) }}</span>
          <span class="rounded-full border border-white/25 px-5 py-1 text-white/85">{{ game.totalRounds }} QUESTIONS</span>
        </p>
        <ul class="mt-7 flex flex-wrap gap-3" aria-label="Players">
          <li
            v-for="p in game.players"
            :key="p.playerId"
            class="rounded-module bg-acid-lime px-6 py-2 font-display text-[2rem] leading-none font-extrabold tracking-tighter text-obsidian uppercase motion-safe:animate-pill-pop"
          >
            {{ p.name }}
          </li>
          <li v-if="!game.players.length" class="font-mono text-[1.25rem] tracking-widest text-white/70 uppercase">
            NO PLAYERS YET
          </li>
        </ul>
      </template>

      <!-- QUESTION + REVEAL -->
      <template v-else-if="phase === 'QUESTION' || phase === 'REVEAL'">
        <p class="rounded-module border border-white/12 bg-surface px-[2.5rem] py-[1.75rem] text-[2.75rem] leading-[1.15] font-semibold">
          {{ game.questionText }}
        </p>
        <ul class="mt-5 grid grid-cols-2 gap-4" aria-label="Answers">
          <li
            v-for="o in game.options"
            :key="o.id"
            class="flex items-center gap-5 rounded-module border px-[2rem] py-[1.4rem] transition-opacity duration-300"
            :class="
              phase === 'REVEAL'
                ? o.id === game.correctOptionId
                  ? 'border-acid-lime bg-acid-lime text-obsidian'
                  : 'border-white/12 bg-surface opacity-30'
                : 'border-white/25 bg-surface-elevated'
            "
          >
            <span class="font-mono text-[2.25rem] font-bold" :class="phase === 'REVEAL' && o.id === game.correctOptionId ? '' : 'text-acid-lime'">{{ o.id }}</span>
            <span class="min-w-0 text-[2.1rem] leading-tight font-semibold break-words">{{ o.text }}</span>
          </li>
        </ul>
      </template>

      <!-- PODIUM -->
      <div v-else class="flex items-end justify-center gap-6">
        <div v-for="slot in podium" :key="slot.place" class="flex w-[19rem] flex-col items-center">
          <template v-if="slot.player">
            <Crown v-if="slot.place === 1" class="mb-2 size-[3rem] text-acid-lime" :stroke-width="ICON_STROKE" aria-hidden="true" />
            <p class="max-w-full truncate font-display text-[2.25rem] leading-none font-extrabold tracking-tighter uppercase">{{ slot.player.name }}</p>
            <div
              class="mt-3 flex w-full flex-col items-center justify-start rounded-t-module border border-b-0 pt-4 motion-safe:animate-rise-in"
              :class="[slot.height, slot.place === 1 ? 'border-acid-lime bg-acid-lime text-obsidian' : 'border-white/25 bg-surface-elevated']"
              :style="{ animationDelay: slot.delay }"
            >
              <span class="font-mono text-[1.25rem] font-bold tracking-widest">#{{ slot.place }}</span>
              <span class="font-display text-[4.5rem] leading-none font-extrabold tracking-tighter tabular-nums">{{ slot.player.score }}</span>
              <span class="font-mono text-[1.1rem] tracking-widest uppercase">PTS</span>
            </div>
          </template>
        </div>
      </div>
    </main>

    <!-- FOOTER: phase readout on the left, join QR stays visible on the right -->
    <footer class="relative flex min-h-[9rem] items-end justify-between gap-[3rem]">
      <div class="min-w-0 flex-1">
        <template v-if="phase === 'QUESTION'">
          <p class="font-mono text-[1.5rem] tracking-widest uppercase">
            <span class="text-acid-lime tabular-nums">{{ game.lockedInCount }} / {{ game.players.length }}</span>
            LOCKED IN
          </p>
          <ul class="mt-3 flex flex-wrap gap-2">
            <li
              v-for="p in lockPills"
              :key="p.playerId"
              class="rounded-full border px-4 py-1 font-mono text-[1.1rem] tracking-widest uppercase transition-colors duration-300"
              :class="p.hasAnsweredCurrent ? 'border-acid-lime bg-acid-lime text-obsidian' : 'border-white/25 text-white/70'"
            >
              {{ p.name }}
            </li>
            <li v-if="hiddenPlayers" class="px-2 py-1 font-mono text-[1.1rem] tracking-widest text-white/70">+{{ hiddenPlayers }}</li>
          </ul>
        </template>

        <template v-else-if="phase === 'REVEAL'">
          <p class="flex items-center gap-3 font-mono text-[1.5rem] tracking-widest uppercase">
            <Zap class="size-[1.2em] text-acid-lime" :stroke-width="ICON_STROKE" aria-hidden="true" />
            <template v-if="game.roundFastestPlayerName">
              FASTEST: <span class="text-acid-lime">{{ game.roundFastestPlayerName }}</span>
            </template>
            <template v-else>NOBODY GOT IT</template>
          </p>
          <ol class="mt-3 flex flex-wrap gap-3">
            <li
              v-for="(p, i) in standings.slice(0, 5)"
              :key="p.playerId"
              class="flex items-center gap-3 rounded-module border border-white/25 bg-surface px-4 py-1.5 font-mono text-[1.1rem] tracking-widest uppercase"
            >
              <span class="text-acid-lime">{{ pad2(i + 1) }}</span>
              <span class="max-w-[10rem] truncate">{{ p.name }}</span>
              <span class="tabular-nums">{{ p.score }}</span>
              <span v-if="p.streak >= 2" class="flex items-center gap-1 text-vinyl-amber">
                <Flame class="size-[1.1em]" :stroke-width="ICON_STROKE" aria-hidden="true" />{{ p.streak }}x STREAK
              </span>
            </li>
          </ol>
        </template>

        <p v-else-if="phase === 'LOBBY'" class="font-mono text-[1.25rem] tracking-widest text-white/70 uppercase">
          WAITING FOR HOST
        </p>
      </div>

      <div class="flex shrink-0 items-end gap-4 font-mono text-[1.1rem] tracking-widest uppercase">
        <p class="pb-1 text-right text-acid-lime">SCAN<br />TO PLAY</p>
        <div class="size-[8rem] overflow-hidden rounded-module bg-white [&>svg]:size-full">
          <QrcodeVue :value="store.qrJoinUrl" :size="192" level="L" render-as="svg" :margin="4" />
        </div>
      </div>
    </footer>
  </div>
</template>
