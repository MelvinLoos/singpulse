<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import QrcodeVue from 'qrcode.vue';
import { Radio, TriangleAlert } from 'lucide-vue-next';
import type { PlaybackCommand, QueueItem } from '@singpulse/shared/types';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { STATUS_META, TONE_TEXT } from '../lib/status.ts';
import { cleanTitle, displayHost, formatDuration, formatIndex, formatTimecode, splitArtist } from '../lib/format.ts';
import SegmentBar from '../components/SegmentBar.vue';
import EqualizerBadge from '../components/EqualizerBadge.vue';

const CUE_DURATION_MS = 3200;
const CUE_EXIT_MS = 600;
const FLASH_DURATION_MS = 6000;

const store = useKaraokeStore();
const videoEl = ref<HTMLVideoElement | null>(null);

// A rotated party token re-renders the QR; pulse its frame so the room notices
const qrPulse = ref(false);
let qrPulseTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => store.partyToken,
  (next, prev) => {
    if (!prev || !next) return; // first sync is not a rotation
    qrPulse.value = true;
    if (qrPulseTimer) clearTimeout(qrPulseTimer);
    qrPulseTimer = setTimeout(() => (qrPulse.value = false), 2500);
  }
);

const upcoming = computed(() => store.queue.slice(0, 4));
const nextUp = computed(() => store.queue.find((item) => item.status !== 'error') ?? null);
const joinHost = computed(() => `${displayHost(store.remoteBaseUrl)}/REMOTE`);
const nowPlaying = computed(() => (store.currentSong ? splitArtist(store.currentSong.title) : null));

// Playback clock for the HUD timecode
const elapsed = ref(0);
const total = ref(0);

function onTimeUpdate(): void {
  const video = videoEl.value;
  if (!video) return;
  elapsed.value = video.currentTime;
  total.value = Number.isFinite(video.duration) ? video.duration : (store.currentSong?.duration ?? 0);
}

// Signature moment: a full-screen cue card as each new singer takes the mic
const cue = ref<{ singer: string; title: string } | null>(null);
const cueLeaving = ref(false);
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

function showCue(song: QueueItem): void {
  cue.value = { singer: song.singer, title: cleanTitle(song.title) };
  cueLeaving.value = false;
  later(() => (cueLeaving.value = true), CUE_DURATION_MS);
  later(() => (cue.value = null), CUE_DURATION_MS + CUE_EXIT_MS);
}

// Short-lived readout explaining why a track vanished
const flash = ref<string | null>(null);

function showFlash(message: string): void {
  flash.value = message;
  later(() => {
    if (flash.value === message) flash.value = null;
  }, FLASH_DURATION_MS);
}

// Autoplay is unlocked by MainActivity on Android TV. A plain browser (e.g. a
// laptop on HDMI) refuses unmuted autoplay, so fall back to muted playback and
// let the next remote key press restore sound.
const soundBlocked = ref(false);

function playSafely(video: HTMLVideoElement): void {
  video.play().catch((err: unknown) => {
    if (!(err instanceof DOMException) || err.name !== 'NotAllowedError') return;
    video.muted = true;
    soundBlocked.value = true;
    video.play().catch(() => {});
  });
}

function unlockSound(): void {
  const video = videoEl.value;
  soundBlocked.value = false;
  if (!video) return;
  video.muted = false;
  if (!store.isPaused) playSafely(video);
}

function applyPauseState(): void {
  const video = videoEl.value;
  if (!video) return;
  if (store.isPaused) video.pause();
  else playSafely(video);
}

function handleCommand(command: PlaybackCommand): void {
  const video = videoEl.value;
  if (!video) return;
  switch (command.action) {
    case 'toggle_pause':
      // STATE_SYNC (with the new isPaused) always arrives before the relayed command
      applyPauseState();
      break;
    case 'restart':
      video.currentTime = 0;
      playSafely(video);
      break;
    case 'volume':
      if (typeof command.value === 'number') {
        // Accept 0-1 or 0-100
        const level = command.value > 1 ? command.value / 100 : command.value;
        video.volume = Math.min(1, Math.max(0, level));
      }
      break;
    case 'skip':
      // Handled server-side: the next STATE_SYNC swaps currentSong
      break;
  }
}

function onEnded(): void {
  if (store.currentSong) store.notifySongEnded(store.currentSong.id);
}

function onVideoError(): void {
  if (!store.currentSong) return;
  showFlash('TRACK FAILED — SKIPPED');
  store.notifySongEnded(store.currentSong.id);
}

function onKeydown(event: KeyboardEvent): void {
  let command: PlaybackCommand | null = null;
  switch (event.key) {
    case 'Enter':
    case 'MediaPlayPause':
    case ' ':
      command = { action: 'toggle_pause' };
      break;
    case 'MediaTrackNext':
    case 'ArrowRight':
      command = { action: 'skip' };
      break;
    case 'ArrowLeft':
      command = { action: 'restart' };
      break;
  }
  if (!command) return;
  event.preventDefault();
  if (event.repeat || !store.currentSong) return;
  if (soundBlocked.value) {
    // This key press is the user gesture the browser wanted: spend it on sound
    unlockSound();
    return;
  }
  store.sendCommand(command);
}

watch(
  () => store.currentSong?.id,
  async (id) => {
    elapsed.value = 0;
    total.value = store.currentSong?.duration ?? 0;
    if (!id || !store.currentSong) return;
    showCue(store.currentSong);
    await nextTick();
    const video = videoEl.value;
    if (video) {
      video.load();
      playSafely(video);
    }
  },
  { immediate: true }
);

watch(() => store.isPaused, applyPauseState);

onMounted(() => {
  document.documentElement.classList.add('tv-mode');
  store.registerCommandHandler(handleCommand);
  window.addEventListener('keydown', onKeydown);
  store.connect('tv');
});

onUnmounted(() => {
  document.documentElement.classList.remove('tv-mode');
  store.registerCommandHandler(null);
  window.removeEventListener('keydown', onKeydown);
  if (qrPulseTimer) clearTimeout(qrPulseTimer);
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
});

const screws = ['top-2.5 left-2.5', 'top-2.5 right-2.5', 'bottom-2.5 left-2.5', 'bottom-2.5 right-2.5'];
const joinSteps = ['SCAN THE CODE', 'SET YOUR STAGE NAME', 'SEARCH + QUEUE A TRACK'];
</script>

<template>
  <div class="fixed inset-0 overflow-hidden bg-obsidian text-white select-none">
    <!-- ACTIVE PLAYBACK -->
    <template v-if="store.currentSong?.mediaUrl">
      <video
        ref="videoEl"
        class="absolute inset-0 size-full bg-black object-contain"
        :src="store.currentSong.mediaUrl"
        autoplay
        playsinline
        @ended="onEnded"
        @error="onVideoError"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onTimeUpdate"
      />

      <!-- Lower left: who is singing what. Narrow and light so the video's lyrics stay readable. -->
      <section
        class="hud-glass absolute bottom-[2.25rem] left-[4rem] w-max max-w-[26rem] rounded-module border border-white/10 bg-obsidian/55 backdrop-blur-md"
        aria-label="Now playing"
      >
        <p
          v-if="soundBlocked"
          class="rounded-t-module bg-vinyl-amber px-4 py-1.5 font-mono text-sm font-bold tracking-widest text-obsidian uppercase"
          role="status"
        >
          SOUND OFF // PRESS OK TO UNMUTE
        </p>

        <div class="px-4 pt-3 pb-3.5">
          <p class="flex items-center gap-3 font-mono text-sm tracking-widest uppercase" :class="store.isPaused ? 'text-vinyl-amber' : 'text-acid-lime'">
            <EqualizerBadge :active="!store.isPaused" class="text-[1.1rem]" :class="store.isPaused ? 'text-vinyl-amber' : ''" />
            {{ store.isPaused ? 'PAUSED' : 'ON AIR' }}
            <span class="text-white/70 tabular-nums">{{ formatTimecode(elapsed) }} / {{ formatDuration(total) }}</span>
          </p>
          <p class="mt-1.5 truncate font-display text-[2rem] leading-none font-extrabold tracking-tighter text-acid-lime uppercase">
            {{ store.currentSong.singer }}
          </p>
          <p class="mt-1.5 truncate text-[1.25rem] leading-snug font-semibold">{{ nowPlaying?.song }}</p>
          <p v-if="nowPlaying?.artist" class="truncate font-mono text-sm tracking-widest text-white/80 uppercase">
            {{ nowPlaying.artist }}
          </p>
        </div>
      </section>

      <!-- Upper right: join + next mic. The QR dominates so it scans from across the room. -->
      <aside
        class="hud-glass absolute top-[2.25rem] right-[4rem] flex items-stretch gap-4 rounded-module border border-white/10 bg-obsidian/55 p-3 backdrop-blur-md"
        aria-label="Join the party"
      >
        <div class="flex w-[9rem] flex-col justify-between py-1 font-mono text-sm tracking-widest uppercase">
          <div class="min-w-0">
            <p class="text-white/70">NEXT MIC</p>
            <p class="truncate font-sans text-[1.25rem] leading-tight font-semibold tracking-normal normal-case">
              {{ nextUp?.singer ?? 'Open mic' }}
            </p>
            <p v-if="nextUp" class="truncate" :class="TONE_TEXT[STATUS_META[nextUp.status].tone]">
              {{ STATUS_META[nextUp.status].tv }}
            </p>
          </div>
          <p class="text-acid-lime">SCAN<br />TO SING</p>
        </div>
        <div class="size-[8rem] shrink-0 overflow-hidden rounded-module bg-white transition-shadow duration-500 [&>svg]:size-full" :class="qrPulse ? 'ring-4 ring-acid-lime' : 'ring-0 ring-transparent'">
          <QrcodeVue :value="store.qrJoinUrl" :size="192" level="L" render-as="svg" :margin="4" />
        </div>
      </aside>
    </template>

    <!-- IDLE STAGE SCREEN -->
    <template v-else>
      <div class="pointer-events-none absolute inset-0 bg-grid-lines" aria-hidden="true" />
      <div
        class="pointer-events-none absolute top-1/2 right-[-18rem] size-[56rem] -translate-y-1/2 rounded-full border border-white/12 bg-vinyl-grooves"
        aria-hidden="true"
      />

      <main class="relative grid h-full grid-cols-[minmax(0,1fr)_23rem] gap-x-[5rem] px-[4rem] py-[2.25rem]">
        <section class="flex min-w-0 flex-col">
          <header class="flex items-center justify-between gap-6 font-mono text-sm tracking-widest text-white/70 uppercase">
            <span>SINGPULSE // STAGE RECEIVER</span>
            <span class="flex items-center gap-3" role="status">
              <span
                class="size-[0.55rem] rounded-full"
                :class="store.connected ? 'bg-acid-lime' : 'bg-vinyl-amber motion-safe:animate-shimmer'"
                aria-hidden="true"
              />
              <template v-if="store.connected">
                ONLINE // TOKEN: <span class="text-white normal-case">{{ store.partyToken }}</span>
              </template>
              <template v-else>RECONNECTING…</template>
            </span>
          </header>

          <div class="mt-[2rem] motion-safe:animate-drift">
            <h1 class="font-display text-[6rem] leading-[0.8] font-extrabold tracking-tighter uppercase">
              Sing<br /><span class="text-acid-lime">Pulse</span>
            </h1>
            <p class="mt-5 font-mono text-sm tracking-widest text-white/70 uppercase">
              Late-night karaoke // fair rotation // everyone sings
            </p>
          </div>

          <section class="mt-auto pt-[1.5rem]" aria-labelledby="setlist-title">
            <div class="flex items-end justify-between border-b border-white/12 pb-3 font-mono text-sm tracking-widest uppercase">
              <h2 id="setlist-title" class="text-white">UPCOMING SETLIST</h2>
              <span class="text-white/70 tabular-nums">{{ String(store.queue.length).padStart(2, '0') }} IN QUEUE</span>
            </div>

            <ol v-if="upcoming.length">
              <li
                v-for="(item, index) in upcoming"
                :key="item.id"
                class="grid grid-cols-[3rem_minmax(0,1fr)_12.5rem] items-center gap-x-6 border-b border-white/12 py-[0.6rem]"
              >
                <span class="font-mono text-[1.25rem] text-white/70 tabular-nums">{{ formatIndex(index) }}</span>
                <div class="min-w-0">
                  <p class="truncate text-[1.375rem] leading-tight font-semibold">{{ cleanTitle(item.title) }}</p>
                  <p class="mt-0.5 truncate font-mono text-[1.2rem] leading-tight tracking-wider text-acid-lime uppercase">{{ item.singer }}</p>
                </div>
                <div class="flex flex-col gap-2">
                  <SegmentBar :item="item" class="h-[0.5rem]" />
                  <span class="font-mono text-sm tracking-widest uppercase" :class="TONE_TEXT[STATUS_META[item.status].tone]">
                    {{ STATUS_META[item.status].tv }}
                  </span>
                </div>
              </li>
            </ol>
            <p v-else class="py-[1.75rem] font-mono text-[1.125rem] tracking-widest text-white/70 uppercase">
              NO TRACKS YET. SCAN TO DROP THE FIRST ONE.
            </p>
          </section>
        </section>

        <aside class="flex flex-col justify-center motion-safe:animate-drift [animation-delay:-48s]" aria-label="Join the party">
          <div class="relative rounded-module border border-white/12 bg-surface">
            <span
              v-for="screw in screws"
              :key="screw"
              class="absolute size-[0.45rem] rounded-full border border-white/20 bg-surface-elevated"
              :class="screw"
              aria-hidden="true"
            />
            <div class="flex items-center justify-between border-b border-white/12 px-6 py-4 font-mono text-sm tracking-widest uppercase">
              <span class="text-white/70">MODULE 02 // UPLINK</span>
              <span class="flex items-center gap-2 text-neon-coral">
                <Radio class="size-[1.1em]" :stroke-width="1.75" aria-hidden="true" />
                LIVE
              </span>
            </div>

            <div class="px-7 pt-6 pb-6">
              <div class="mx-auto size-[13rem] overflow-hidden rounded-module bg-white transition-shadow duration-500 [&>svg]:size-full" :class="qrPulse ? 'ring-4 ring-acid-lime' : 'ring-0 ring-transparent'">
                <QrcodeVue :value="store.qrJoinUrl" :size="260" level="M" render-as="svg" :margin="4" />
              </div>
              <p class="mt-5 text-center font-display text-[1.75rem] leading-none font-extrabold tracking-tighter whitespace-nowrap uppercase">
                Scan to sing
              </p>
            </div>

            <!-- Ticket-stub tear line -->
            <div class="relative h-px bg-perforation" aria-hidden="true">
              <span class="absolute top-1/2 -left-[0.6rem] size-[1.2rem] -translate-y-1/2 rounded-full border border-white/12 bg-obsidian" />
              <span class="absolute top-1/2 -right-[0.6rem] size-[1.2rem] -translate-y-1/2 rounded-full border border-white/12 bg-obsidian" />
            </div>

            <ol class="space-y-3 px-7 py-6 font-mono text-sm tracking-widest uppercase">
              <li v-for="(step, index) in joinSteps" :key="step" class="flex gap-4">
                <span class="text-acid-lime tabular-nums">{{ formatIndex(index) }}</span>
                <span class="text-white/85">{{ step }}</span>
              </li>
            </ol>

            <p class="truncate border-t border-white/12 px-7 py-4 font-mono text-sm tracking-widest text-white/70">{{ joinHost }}</p>
          </div>
        </aside>
      </main>
    </template>

    <!-- SONG-CHANGE CUE CARD -->
    <div
      v-if="cue"
      class="absolute inset-0 z-20 flex items-center overflow-hidden bg-obsidian"
      :class="cueLeaving ? 'motion-safe:animate-cue-out motion-reduce:opacity-0' : ''"
      aria-live="polite"
    >
      <div class="pointer-events-none absolute inset-0 bg-grid-lines" aria-hidden="true" />
      <div class="relative grid w-full grid-cols-[21rem_minmax(0,1fr)] items-center gap-x-[4rem] px-[4rem]">
        <div class="relative aspect-square rounded-full border border-white/12 bg-vinyl-grooves motion-safe:animate-spin-up" aria-hidden="true">
          <div class="absolute inset-[33%] flex items-center justify-center rounded-full bg-neon-coral">
            <span class="size-[14%] rounded-full bg-obsidian" />
          </div>
          <span class="absolute top-[5%] left-1/2 h-[24%] w-[3px] -translate-x-1/2 bg-acid-lime" />
        </div>
        <div class="min-w-0">
          <p class="font-mono text-[1.125rem] tracking-widest text-white/70 uppercase motion-safe:animate-rise-in">
            NOW ON MIC
          </p>
          <p
            class="mt-3 line-clamp-2 font-display text-[6.5rem] leading-[0.85] font-extrabold tracking-tighter break-words text-acid-lime uppercase motion-safe:animate-rise-in [animation-delay:120ms]"
          >
            {{ cue.singer }}
          </p>
          <p class="mt-6 truncate text-[1.75rem] text-white/80 motion-safe:animate-rise-in [animation-delay:240ms]">
            {{ cue.title }}
          </p>
        </div>
      </div>
    </div>

    <!-- TRANSIENT READOUT -->
    <div
      v-if="flash"
      class="absolute top-[2.25rem] left-[4rem] z-30 flex items-center gap-3 rounded-module bg-neon-coral px-5 py-2.5 font-mono text-sm font-bold tracking-widest text-obsidian uppercase"
      role="alert"
    >
      <TriangleAlert class="size-[1.1em]" :stroke-width="2" aria-hidden="true" />
      {{ flash }}
    </div>
  </div>
</template>
