<script setup lang="ts">
import { computed } from 'vue';
import type { QueueItem } from '@singpulse/shared/types';
import { STATUS_META, TONE_FILL, litSegments } from '../lib/status.ts';

const props = withDefaults(defineProps<{
  item: Pick<QueueItem, 'status' | 'progress'>;
  segments?: number;
}>(), { segments: 10 });

const tone = computed(() => STATUS_META[props.item.status].tone);
const lit = computed(() => litSegments(props.item, props.segments));
const percent = computed(() => Math.round((lit.value / props.segments) * 100));
</script>

<template>
  <div
    class="flex items-stretch gap-[3px]"
    role="meter"
    aria-label="Download progress"
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
