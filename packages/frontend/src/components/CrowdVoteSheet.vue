<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Star } from 'lucide-vue-next';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { SUPERLATIVES } from '../lib/superlatives.ts';
import type { VotingSessionState } from '@singpulse/shared/types';

const VOTE_TOTAL_MS = 10000;
const ICON_STROKE = 1.75;

const props = defineProps<{ vote: VotingSessionState }>();

const store = useKaraokeStore();

const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  navigator.vibrate?.(100);
  tick = setInterval(() => (now.value = Date.now()), 100);
});

onUnmounted(() => {
  if (tick) clearInterval(tick);
});

const remainingMs = computed(() => Math.max(0, props.vote.endsAt - now.value));
const seconds = computed(() => String(Math.ceil(remainingMs.value / 1000)).padStart(2, '0'));
const barScale = computed(() => Math.min(1, remainingMs.value / VOTE_TOTAL_MS));

const mine = computed(() => (store.hasVotedCurrentSong ? store.myCurrentVote : null));
const locked = computed(() => props.vote.revealed || remainingMs.value === 0);

function rate(stars: number): void {
  if (locked.value) return;
  navigator.vibrate?.(10);
  store.submitCrowdVote(stars);
}

function pick(key: (typeof SUPERLATIVES)[number]['key']): void {
  if (locked.value) return;
  navigator.vibrate?.(10);
  store.submitCrowdVote(undefined, key);
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-end bg-obsidian/72" role="dialog" aria-modal="true" aria-labelledby="vote-title">
    <section class="w-full rounded-t-[6px] border-t border-acid-lime bg-surface px-safe pt-3 pb-safe motion-safe:animate-sheet-up">
      <div class="mx-auto h-1 w-10 rounded-full bg-white/25" aria-hidden="true" />

      <header class="mt-3">
        <p class="flex items-center justify-between gap-3 font-mono text-[11px] tracking-widest uppercase">
          <span id="vote-title" class="min-w-0 truncate text-acid-lime">RATE // {{ vote.singer }}</span>
          <span class="shrink-0 text-white/70 tabular-nums">{{ locked ? 'LOCKED' : `00:${seconds}` }}</span>
        </p>
        <div class="mt-2 h-1.5 bg-white/12" aria-hidden="true">
          <div class="h-full origin-left bg-acid-lime" :style="{ transform: `scaleX(${barScale})` }" />
        </div>
      </header>

      <div class="mt-4 grid grid-cols-5 gap-2" role="group" aria-label="Star rating">
        <button
          v-for="n in 5"
          :key="n"
          type="button"
          class="grid h-16 place-items-center rounded-key border active:translate-y-px disabled:opacity-60"
          :class="mine && n <= mine.stars ? 'border-acid-lime bg-acid-lime text-obsidian' : 'border-white/12 bg-surface-elevated text-white/70'"
          :aria-label="`${n} ${n === 1 ? 'star' : 'stars'}`"
          :aria-pressed="mine?.stars === n"
          :disabled="locked"
          @click="rate(n)"
        >
          <Star class="size-7" :stroke-width="ICON_STROKE" :fill="mine && n <= mine.stars ? 'currentColor' : 'none'" />
        </button>
      </div>

      <div class="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Superlative">
        <button
          v-for="entry in SUPERLATIVES"
          :key="entry.key"
          type="button"
          class="flex h-14 items-center justify-center gap-2 rounded-key border font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px disabled:opacity-60"
          :class="mine?.superlative === entry.key ? 'border-acid-lime bg-acid-lime text-obsidian' : 'border-white/12 bg-surface-elevated text-white'"
          :aria-pressed="mine?.superlative === entry.key"
          :disabled="locked"
          @click="pick(entry.key)"
        >
          <component :is="entry.icon" class="size-5" :stroke-width="ICON_STROKE" aria-hidden="true" />
          {{ entry.label }}
        </button>
      </div>

      <p class="mt-3 pb-1 text-center font-mono text-[11px] tracking-widest text-white/70 uppercase" role="status">
        {{ locked ? 'RESULTS ON TV' : mine ? 'VOTED' : '' }}
      </p>
    </section>
  </div>
</template>
