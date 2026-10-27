<script setup lang="ts">
withDefaults(defineProps<{ active?: boolean }>(), { active: true });

// Bar heights at rest and stagger offsets give the meter an irregular, "live" rhythm.
const bars = [
  { x: 1, delay: '-0.2s', rest: 0.45 },
  { x: 6, delay: '-0.65s', rest: 0.8 },
  { x: 11, delay: '-0.35s', rest: 0.6 },
  { x: 16, delay: '-0.9s', rest: 0.35 }
];
</script>

<template>
  <svg viewBox="0 0 20 16" class="h-[1em] w-[1.25em] shrink-0 text-acid-lime" aria-hidden="true">
    <rect
      v-for="bar in bars"
      :key="bar.x"
      :x="bar.x"
      y="0"
      width="3"
      height="16"
      rx="0.5"
      fill="currentColor"
      class="origin-bottom [transform-box:fill-box]"
      :class="active ? 'motion-safe:animate-eq-bar' : ''"
      :style="active ? { animationDelay: bar.delay, transform: `scaleY(${bar.rest})` } : { transform: `scaleY(${bar.rest})` }"
    />
  </svg>
</template>
