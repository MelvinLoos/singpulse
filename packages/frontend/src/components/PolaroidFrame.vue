<script setup lang="ts">
import { computed } from 'vue';
import type { PolaroidItem } from '@singpulse/shared/types';

const props = defineProps<{ item: PolaroidItem }>();

// 27 OCT 26 21:04, in the guest-visible venue time
const stamp = computed(() => {
  const d = new Date(props.item.createdAt);
  const day = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString('en', { month: 'short' }).toUpperCase();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${day} ${month} ${String(d.getFullYear()).slice(-2)} ${time}`;
});
</script>

<template>
  <figure
    class="bg-film-paper p-[0.5em] pb-[0.4em] text-obsidian shadow-[0_0.15em_0_rgb(0_0_0/0.5)]"
    :style="{ '--tilt': `${item.rotationDeg}deg`, transform: `rotate(${item.rotationDeg}deg)` }"
  >
    <img
      :src="item.imageUrl"
      alt=""
      class="aspect-square w-full bg-obsidian object-cover"
      loading="lazy"
      decoding="async"
    />
    <figcaption class="mt-[0.4em] font-mono text-[0.5em] leading-tight tracking-widest uppercase">
      <span class="flex justify-between gap-2">
        <span class="truncate font-bold">[{{ item.sender }}]</span>
        <span class="shrink-0 tabular-nums">{{ stamp }}</span>
      </span>
      <span v-if="item.caption" class="mt-[0.3em] block truncate text-[1.1em] font-bold">{{ item.caption }}</span>
    </figcaption>
  </figure>
</template>
