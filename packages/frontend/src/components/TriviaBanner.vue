<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Maximize2, Trophy } from 'lucide-vue-next';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { categoryLabel } from '../lib/trivia.ts';

const emit = defineEmits<{ join: []; announce: [message: string] }>();

const store = useKaraokeStore();
const game = computed(() => store.activeTrivia);

// Dismissal is remembered per game, so the next lobby invites everyone again
const dismissedGameId = ref<string | null>(null);
const dismissed = computed(() => game.value !== null && dismissedGameId.value === game.value.gameId);

const mode = computed<'invite' | 'chip' | 'return' | null>(() => {
  if (!game.value) return null;
  if (!store.isJoinedInTrivia) return dismissed.value ? 'chip' : 'invite';
  return store.triviaMinimized ? 'return' : null;
});

const round = computed(() =>
  game.value && game.value.phase !== 'LOBBY' ? ` (ROUND ${game.value.roundIndex + 1}/${game.value.totalRounds})` : ' (LOBBY)'
);

watch(
  () => game.value?.gameId,
  (id) => {
    if (id && !store.isJoinedInTrivia) emit('announce', 'Trivia Blitz is open. Join the game or keep browsing songs.');
  }
);
</script>

<template>
  <div v-if="game && mode" class="mt-2" role="region" aria-label="Trivia Blitz">
    <div
      v-if="mode === 'invite'"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-module border border-acid-lime bg-surface py-1 pl-3"
    >
      <p class="min-w-0 flex-1 py-1.5 font-mono text-[11px] font-bold tracking-widest text-acid-lime uppercase">
        TRIVIA BLITZ // {{ categoryLabel(game.category) }}{{ round }}
      </p>
      <div class="flex items-center">
        <button
          type="button"
          class="h-11 rounded-key bg-acid-lime px-3 font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px"
          @click="emit('join')"
        >
          Join game
        </button>
        <button
          type="button"
          class="h-11 px-3 font-mono text-[11px] font-bold tracking-widest text-white/80 uppercase active:text-white"
          @click="dismissedGameId = game.gameId"
        >
          Dismiss
        </button>
      </div>
    </div>

    <button
      v-else-if="mode === 'chip'"
      type="button"
      class="flex h-11 w-full items-center justify-between rounded-module border border-white/25 bg-surface px-3 font-mono text-[11px] font-bold tracking-widest text-white/80 uppercase active:translate-y-px"
      @click="emit('join')"
    >
      <span>TRIVIA LIVE // {{ categoryLabel(game.category) }}</span>
      <span class="text-acid-lime">Join</span>
    </button>

    <button
      v-else
      type="button"
      class="flex min-h-11 w-full items-center justify-between gap-3 rounded-module border border-acid-lime bg-acid-lime px-3 text-left font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px"
      @click="store.triviaMinimized = false"
    >
      <span class="flex min-w-0 items-center gap-2">
        <Trophy class="size-4 shrink-0" :stroke-width="1.75" aria-hidden="true" />
        <span class="truncate">TRIVIA ACTIVE // YOUR SCORE: {{ store.myTriviaPlayer?.score ?? 0 }} PTS</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">Return to pad <Maximize2 class="size-4" :stroke-width="1.75" aria-hidden="true" /></span>
    </button>
  </div>
</template>
