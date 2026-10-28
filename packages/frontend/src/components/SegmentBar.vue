<script setup lang="ts">
import { computed } from 'vue';
import type { QueueItem } from '@singpulse/shared/types';
import { STATUS_META, TONE_FILL, litSegments } from '../lib/status.ts';
import type { StatusTone } from '../lib/status.ts';

// Either a queue item (status-driven) or a plain 0-1 `fill` with an explicit tone
const props = withDefaults(defineProps<{
  item?: Pick<QueueItem, 'status' | 'progress'>;
  fill?: number;
  tone?: StatusTone;
  label?: string;
  segments?: number;
}>(), { segments: 10, label: 'Download progress' });

const tone = computed(() => props.tone ?? (props.item ? STATUS_META[props.item.status].tone : 'ready'));
const lit = computed(() => {
  if (props.fill !== undefined) return Math.round(Math.min(1, Math.max(0, props.fill)) * props.segments);
  return props.item ? litSegments(props.item, props.segments) : 0;
});
const percent = computed(() => Math.round((lit.value / props.segments) * 100));
</script>

<template>
  <div
    class="flex items-stretch gap-[3px]"
    role="meter"
    :aria-label="label"
    :aria-valuenow="percent"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <span
      v-for="n in segments"
      :key="n"
      class="flex-1 rounded-[1px] transition-colors duration-300"
      :class="n <= lit ? TONE_FILL[tone] : 'bg-white/10'"
    />
  </div>
</template>
