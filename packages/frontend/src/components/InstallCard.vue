<script setup lang="ts">
import { computed } from 'vue';
import { Download, Share, X } from 'lucide-vue-next';
import { dismissInstallCard, dismissed, installEvent, installed, isIosSafari, isStandalone, promptInstall } from '../lib/pwa.ts';

const ICON_STROKE = 1.75;

const mode = computed<'prompt' | 'ios' | null>(() => {
  if (isStandalone || installed.value || dismissed.value) return null;
  if (installEvent.value) return 'prompt';
  return isIosSafari ? 'ios' : null;
});
</script>

<template>
  <section
    v-if="mode"
    class="standalone:hidden mt-6 flex items-center gap-3 rounded-module border border-white/12 bg-surface py-1 pl-3"
    aria-label="Install the remote"
  >
    <Download class="size-4 shrink-0 text-acid-lime" :stroke-width="ICON_STROKE" aria-hidden="true" />
    <template v-if="mode === 'prompt'">
      <p class="min-w-0 flex-1 font-mono text-[11px] tracking-widest text-white/70 uppercase">Add to home screen</p>
      <button
        type="button"
        class="h-11 shrink-0 rounded-key bg-acid-lime px-3 font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px active:brightness-90"
        @click="promptInstall"
      >
        Install
      </button>
    </template>
    <p v-else class="min-w-0 flex-1 font-mono text-[11px] tracking-widest text-white/70 uppercase">
      Tap <Share class="inline size-3.5 align-text-bottom text-white" :stroke-width="ICON_STROKE" aria-label="Share" />
      then <span class="text-white">Add to Home Screen</span>
    </p>
    <button
      type="button"
      class="grid size-11 shrink-0 place-items-center text-white/70 active:text-white"
      aria-label="Dismiss install tip"
      @click="dismissInstallCard"
    >
      <X class="size-4" :stroke-width="ICON_STROKE" />
    </button>
  </section>
</template>
