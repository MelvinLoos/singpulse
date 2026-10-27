<script setup lang="ts">
import { computed } from 'vue';
import { Star } from 'lucide-vue-next';
import type { VotingSessionState } from '@singpulse/shared/types';
import { SUPERLATIVES, topSuperlative } from '../lib/superlatives.ts';

const VOTE_TOTAL_MS = 10000;

const props = defineProps<{ vote: VotingSessionState }>();

// The bar was already draining when this screen mounted (late TV reconnect)
const drainDelay = computed(() => `-${Math.min(VOTE_TOTAL_MS, Math.max(0, VOTE_TOTAL_MS - (props.vote.endsAt - Date.now())))}ms`);
const winner = computed(() => topSuperlative(props.vote));
const score = computed(() => props.vote.averageStars.toFixed(1));
</script>

<template>
  <div class="absolute inset-0 z-20 flex flex-col overflow-hidden bg-obsidian px-[4rem] py-[2.25rem]" aria-live="polite">
    <div class="pointer-events-none absolute inset-0 bg-grid-lines" aria-hidden="true" />

    <header class="relative">
      <p class="flex items-center justify-between font-mono text-[1.25rem] tracking-widest uppercase">
        <span class="text-acid-lime">CROWD JURY ACTIVE // VOTE ON YOUR PHONE NOW</span>
        <span class="text-white/70 tabular-nums">PRESS OK TO SKIP</span>
      </p>
      <div class="mt-4 h-[0.6rem] bg-white/12" role="presentation">
        <div
          class="h-full origin-left bg-acid-lime motion-safe:animate-vote-drain"
          :style="{ animationDelay: drainDelay }"
        />
      </div>
    </header>

    <main class="relative flex min-h-0 flex-1 flex-col justify-center">
      <p class="font-mono text-[1.25rem] tracking-widest text-white/70 uppercase">PERFORMANCE BY</p>
      <p class="mt-2 line-clamp-2 font-display text-[7rem] leading-[0.85] font-extrabold tracking-tighter break-words text-acid-lime uppercase">
        {{ vote.singer }}
      </p>
      <p class="mt-5 truncate text-[2rem] font-semibold text-white/85">{{ vote.songTitle }}</p>
    </main>

    <footer class="relative min-h-[11rem]">
      <!-- Voting: live tally -->
      <div v-if="!vote.revealed" class="flex items-end justify-between gap-[3rem]">
        <p class="font-mono tracking-widest uppercase">
          <span class="block text-[1.25rem] text-white/70">VOTES CAST</span>
          <span class="block text-[6rem] leading-none font-bold tabular-nums">{{ String(vote.totalVotes).padStart(2, '0') }}</span>
        </p>
        <ul class="flex flex-wrap justify-end gap-3">
          <li
            v-for="entry in SUPERLATIVES"
            :key="entry.key"
            class="flex items-center gap-3 rounded-full border px-5 py-2 font-mono text-[1.25rem] tracking-widest uppercase"
            :class="vote.superlativeCounts[entry.key] ? 'border-acid-lime text-acid-lime' : 'border-white/12 text-white/70'"
          >
            <component :is="entry.icon" class="size-[1.2em]" :stroke-width="1.75" aria-hidden="true" />
            {{ entry.label }}
            <!-- Re-keyed on every change so the count pops when a vote lands -->
            <span :key="vote.superlativeCounts[entry.key]" class="inline-block tabular-nums motion-safe:animate-pill-pop">
              {{ vote.superlativeCounts[entry.key] }}
            </span>
          </li>
        </ul>
      </div>

      <!-- Reveal: final score -->
      <div v-else class="flex items-end justify-between gap-[3rem]">
        <p class="font-mono tracking-widest uppercase">
          <span class="block text-[1.25rem] text-white/70">FINAL SCORE // {{ vote.totalVotes }} VOTES</span>
          <span v-if="vote.totalVotes" class="flex items-baseline gap-4 motion-safe:animate-pill-pop">
            <span class="font-display text-[9rem] leading-none font-extrabold tracking-tighter text-acid-lime">{{ score }}</span>
            <span class="flex items-center gap-3 text-[2.5rem] text-white/80">/ 5.0 <Star class="size-[1em] text-acid-lime" :stroke-width="1.75" aria-hidden="true" /></span>
          </span>
          <span v-else class="block text-[3rem] leading-none font-bold text-white/70">NO VOTES LOGGED</span>
        </p>
        <p
          v-if="winner"
          class="flex items-center gap-4 rounded-module bg-acid-lime px-8 py-5 font-display text-[3rem] leading-none font-extrabold tracking-tighter text-obsidian uppercase motion-safe:animate-rise-in"
        >
          <component :is="winner.icon" class="size-[1em]" :stroke-width="2" aria-hidden="true" />
          {{ winner.label }}
        </p>
      </div>
    </footer>
  </div>
</template>
