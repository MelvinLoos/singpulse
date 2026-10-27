<script setup lang="ts">
import type { PolaroidItem } from '@singpulse/shared/types';
import PolaroidFrame from './PolaroidFrame.vue';

defineProps<{ items: PolaroidItem[] }>();
</script>

<template>
  <!-- Fresh prints float in the upper-left stage corner for a few seconds -->
  <div class="pointer-events-none absolute top-[2.25rem] left-[4rem] z-10 flex items-start gap-[1.25rem]" aria-live="polite">
    <PolaroidFrame
      v-for="item in items"
      :key="item.id"
      :item="item"
      class="w-[11rem] text-[1.5rem] motion-safe:animate-polaroid-in"
    />
  </div>
</template>
