<script setup lang="ts">
import { computed } from 'vue';
import type { QueueItem } from '@singpulse/shared/types';
import { STATUS_META, TONE_BORDER, TONE_TEXT } from '../lib/status.ts';

const props = defineProps<{ item: Pick<QueueItem, 'status' | 'progress'> }>();

const meta = computed(() => STATUS_META[props.item.status]);
const label = computed(() =>
  props.item.status === 'downloading' && props.item.progress
    ? `${meta.value.label} ${String(props.item.progress).padStart(2, '0')}%`
    : meta.value.label
);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase leading-4 tracking-widest whitespace-nowrap tabular-nums"
    :class="[TONE_TEXT[meta.tone], TONE_BORDER[meta.tone]]"
  >
    <span
      class="size-1.5 rounded-full bg-current"
      :class="item.status === 'downloading' ? 'motion-safe:animate-shimmer' : ''"
      aria-hidden="true"
    />
    {{ label }}
  </span>
</template>
