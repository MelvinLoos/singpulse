<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  Check,
  Disc3,
  ListMusic,
  MicVocal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  SkipForward,
  Trash2,
  Undo2,
  X
} from 'lucide-vue-next';
import type { PlaybackCommand, QueueItem, SearchResult } from '@singpulse/shared/types';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { MAX_SINGER_NAME_LENGTH, useSingerName } from '../lib/singerName.ts';
import { cleanTitle, formatDuration, formatIndex } from '../lib/format.ts';
import EqualizerBadge from '../components/EqualizerBadge.vue';
import StatusBadge from '../components/StatusBadge.vue';

const SEARCH_DEBOUNCE_MS = 350;
const UNDO_WINDOW_MS = 5000;
const ICON_STROKE = 1.75;

const store = useKaraokeStore();
const { singerName, save: saveSingerName } = useSingerName();

// Screen-reader announcements for async outcomes
const announcement = ref('');
function announce(message: string): void {
  announcement.value = '';
  requestAnimationFrame(() => (announcement.value = message));
}

/* ---------------------------------------------------------------- identity */
const editingName = ref(false);
const nameDraft = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

function startEditingName(): void {
  nameDraft.value = singerName.value;
  editingName.value = true;
  requestAnimationFrame(() => nameInput.value?.select());
}

function saveInlineName(): void {
  if (saveSingerName(nameDraft.value)) {
    editingName.value = false;
    announce(`Stage name set to ${singerName.value}`);
  }
}

/* ------------------------------------------------------------------ search */
type SearchState = 'idle' | 'loading' | 'results' | 'empty' | 'error';

const query = ref('');
const results = ref<SearchResult[]>([]);
const searchState = ref<SearchState>('idle');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchController: AbortController | null = null;

async function runSearch(term: string): Promise<void> {
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  searchState.value = 'loading';
  try {
    const found = await store.searchSongs(term, controller.signal);
    if (controller.signal.aborted) return;
    results.value = found;
    searchState.value = found.length ? 'results' : 'empty';
  } catch {
    if (controller.signal.aborted) return;
    searchState.value = 'error';
  }
}

function searchNow(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const term = query.value.trim();
  if (term) void runSearch(term);
}

function clearSearch(): void {
  query.value = '';
}

watch(query, (value) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  const term = value.trim();
  if (!term) {
    searchController?.abort();
    results.value = [];
    searchState.value = 'idle';
    return;
  }
  searchState.value = 'loading';
  debounceTimer = setTimeout(() => void runSearch(term), SEARCH_DEBOUNCE_MS);
});

/* ---------------------------------------------------------------- queueing */
type QueueRequestState = 'pending' | 'queued' | 'failed';
const queueRequests = reactive(new Map<string, QueueRequestState>());
const pendingSong = ref<SearchResult | null>(null);

async function queueSong(song: SearchResult): Promise<void> {
  const state = queueRequests.get(song.videoId);
  if (state === 'pending' || state === 'queued') return;

  queueRequests.set(song.videoId, 'pending'); // optimistic: renders as QUEUED
  navigator.vibrate?.(10);
  try {
    await store.enqueueSong(song, singerName.value);
    queueRequests.set(song.videoId, 'queued');
    announce(`Queued ${cleanTitle(song.title)}`);
  } catch {
    queueRequests.set(song.videoId, 'failed');
    announce(`Could not queue ${cleanTitle(song.title)}. Tap retry.`);
  }
}

function requestQueue(song: SearchResult): void {
  if (!singerName.value) {
    pendingSong.value = song;
    openNameSheet();
    return;
  }
  void queueSong(song);
}

const mySlot = computed(() => {
  const me = singerName.value.toLowerCase();
  if (!me) return -1;
  return store.queue.findIndex((item) => item.singer.trim().toLowerCase() === me);
});

/* --------------------------------------------------------------- transport */
const hasSong = computed(() => store.currentSong !== null);
const transportDisabled = computed(() => !store.connected || !hasSong.value);

function transport(action: PlaybackCommand['action']): void {
  if (transportDisabled.value) return;
  navigator.vibrate?.(8);
  store.sendCommand({ action });
}

/* ------------------------------------------------------- remove with undo */
interface PendingRemoval {
  item: QueueItem;
  timer: ReturnType<typeof setTimeout>;
}
const pendingRemovals = reactive(new Map<string, PendingRemoval>());
const undoItem = ref<QueueItem | null>(null);

const visibleQueue = computed(() => store.queue.filter((item) => !pendingRemovals.has(item.id)));

async function commitRemoval(id: string): Promise<void> {
  const pending = pendingRemovals.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRemovals.delete(id);
  if (undoItem.value?.id === id) undoItem.value = null;
  try {
    await store.removeQueueItem(id);
  } catch {
    announce(`Could not remove ${cleanTitle(pending.item.title)}`);
  }
}

function scheduleRemoval(item: QueueItem): void {
  // Only one undo slot: commit any earlier pending removal right away
  if (undoItem.value) void commitRemoval(undoItem.value.id);
  const timer = setTimeout(() => void commitRemoval(item.id), UNDO_WINDOW_MS);
  pendingRemovals.set(item.id, { item, timer });
  undoItem.value = item;
  announce(`Removed ${cleanTitle(item.title)}. Undo available.`);
}

function undoRemoval(): void {
  const item = undoItem.value;
  if (!item) return;
  const pending = pendingRemovals.get(item.id);
  if (pending) clearTimeout(pending.timer);
  pendingRemovals.delete(item.id);
  undoItem.value = null;
  announce(`Restored ${cleanTitle(item.title)}`);
}

function flushRemovals(): void {
  // Map iteration tolerates the deletes commitRemoval performs synchronously
  for (const id of pendingRemovals.keys()) void commitRemoval(id);
}

/* ------------------------------------------------------------------ sheets */
const queueSheet = ref<HTMLDialogElement | null>(null);
const nameSheet = ref<HTMLDialogElement | null>(null);
const sheetOpen = ref(false);
const nameSheetDraft = ref('');

const supportsClosedBy = typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;

// Light-dismiss fallback for browsers without <dialog closedby> (Safari)
function onSheetClick(event: MouseEvent): void {
  if (supportsClosedBy) return;
  const dialog = event.currentTarget as HTMLDialogElement;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  const inside =
    rect.top <= event.clientY && event.clientY <= rect.bottom && rect.left <= event.clientX && event.clientX <= rect.right;
  if (!inside) dialog.close();
}

function openQueueSheet(): void {
  queueSheet.value?.showModal();
  sheetOpen.value = true;
}

function openNameSheet(): void {
  nameSheetDraft.value = singerName.value;
  nameSheet.value?.showModal();
}

function onNameSheetClose(): void {
  pendingSong.value = null;
}

function submitNameSheet(): void {
  if (!saveSingerName(nameSheetDraft.value)) return;
  editingName.value = false;
  const song = pendingSong.value;
  nameSheet.value?.close();
  if (song) void queueSong(song);
}

/* --------------------------------------------------------------- lifecycle */
onMounted(() => {
  store.connect();
  window.addEventListener('pagehide', flushRemovals);
  // First run: surface the name field without focusing it (no surprise keyboard)
  editingName.value = !singerName.value;
});

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  searchController?.abort();
  window.removeEventListener('pagehide', flushRemovals);
  flushRemovals();
});

const skeletonRows = 6;
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-obsidian text-white">
    <!-- TOP BAR: brand, link state, identity, search -->
    <header class="sticky top-0 z-10 border-b border-white/12 bg-obsidian px-safe pt-safe pb-3">
      <div class="flex items-center justify-between gap-3">
        <p class="flex items-baseline gap-2">
          <span class="font-display text-xl leading-none font-extrabold tracking-tighter uppercase">
            Sing<span class="text-acid-lime">Pulse</span>
          </span>
          <span class="font-mono text-[11px] tracking-widest whitespace-nowrap text-white/70 uppercase max-[380px]:hidden">// Remote</span>
        </p>
        <p class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tracking-widest whitespace-nowrap uppercase" role="status">
          <span
            class="size-1.5 rounded-full"
            :class="store.connected ? 'bg-acid-lime' : 'bg-vinyl-amber motion-safe:animate-shimmer'"
            aria-hidden="true"
          />
          <span :class="store.connected ? 'text-white/70' : 'text-vinyl-amber'">{{ store.connected ? 'LINK OK' : 'RECONNECTING' }}</span>
        </p>
      </div>

      <div class="mt-3 flex min-h-12 items-center gap-2 rounded-key border border-white/12 bg-surface pl-3">
        <MicVocal class="size-4 shrink-0 text-acid-lime" :stroke-width="ICON_STROKE" aria-hidden="true" />
        <template v-if="!editingName">
          <span class="font-mono text-[11px] tracking-widest text-white/70 uppercase">MIC</span>
          <span class="min-w-0 flex-1 truncate font-semibold" :class="singerName ? 'text-white' : 'text-white/70'">
            {{ singerName || 'Set your stage name' }}
          </span>
          <button
            type="button"
            class="grid size-11 shrink-0 place-items-center rounded-key text-white/80 active:translate-y-px active:bg-surface-elevated"
            aria-label="Edit stage name"
            @click="startEditingName"
          >
            <Pencil class="size-4" :stroke-width="ICON_STROKE" />
          </button>
        </template>
        <form v-else class="flex min-w-0 flex-1 items-center" @submit.prevent="saveInlineName">
          <label for="stage-name" class="sr-only">Stage name</label>
          <input
            id="stage-name"
            ref="nameInput"
            v-model="nameDraft"
            :maxlength="MAX_SINGER_NAME_LENGTH"
            class="h-11 min-w-0 flex-1 bg-transparent text-base font-semibold placeholder:text-white/50 focus:outline-none"
            placeholder="Stage name"
            autocomplete="nickname"
            autocapitalize="words"
            enterkeyhint="done"
          />
          <button
            type="submit"
            class="grid size-11 shrink-0 place-items-center rounded-key text-acid-lime active:translate-y-px active:bg-surface-elevated disabled:text-white/30"
            aria-label="Save stage name"
            :disabled="!nameDraft.trim()"
          >
            <Check class="size-5" :stroke-width="ICON_STROKE" />
          </button>
          <button
            v-if="singerName"
            type="button"
            class="grid size-11 shrink-0 place-items-center rounded-key text-white/70 active:translate-y-px active:bg-surface-elevated"
            aria-label="Cancel editing"
            @click="editingName = false"
          >
            <X class="size-5" :stroke-width="ICON_STROKE" />
          </button>
        </form>
      </div>

      <form role="search" class="relative mt-2" @submit.prevent="searchNow">
        <label for="song-search" class="sr-only">Search songs</label>
        <Search
          class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-white/70"
          :stroke-width="ICON_STROKE"
          aria-hidden="true"
        />
        <input
          id="song-search"
          v-model="query"
          type="search"
          inputmode="search"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Artist or song title"
          class="h-12 w-full rounded-key border border-white/12 bg-surface pr-12 pl-10 text-base placeholder:text-white/50 focus:border-acid-lime focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
        />
        <button
          v-if="query"
          type="button"
          class="absolute top-0 right-0 grid size-12 place-items-center text-white/70 active:text-white"
          aria-label="Clear search"
          @click="clearSearch"
        >
          <X class="size-4" :stroke-width="ICON_STROKE" />
        </button>
      </form>
    </header>

    <!-- RESULTS -->
    <main class="flex-1 px-safe pb-[calc(10.5rem+env(safe-area-inset-bottom))]">
      <section v-if="searchState === 'idle'" class="pt-8" aria-label="Get started">
        <p class="font-mono text-[11px] tracking-widest text-white/70 uppercase">Ready when you are</p>
        <h1 class="mt-2 font-display text-4xl leading-[0.9] font-extrabold tracking-tighter uppercase">
          Find your<br /><span class="text-acid-lime">song</span>
        </h1>
        <ul class="mt-6 space-y-2.5 border-t border-white/12 pt-4 font-mono text-[11px] tracking-widest text-white/70 uppercase">
          <li class="flex gap-3"><span class="text-acid-lime">01</span>Search artist + title</li>
          <li class="flex gap-3"><span class="text-acid-lime">02</span>Tap queue. We add “karaoke” for you</li>
          <li class="flex gap-3"><span class="text-acid-lime">03</span>Fair rotation: everyone gets a turn</li>
        </ul>
        <p v-if="mySlot >= 0" class="mt-6 rounded-module border border-acid-lime/40 px-3 py-2.5 font-mono text-[11px] tracking-widest text-acid-lime uppercase">
          Your next slot // {{ formatIndex(mySlot) }}
        </p>
      </section>

      <ul v-else-if="searchState === 'loading'" class="pt-2" aria-label="Searching" aria-busy="true">
        <li v-for="n in skeletonRows" :key="n" class="flex items-center gap-3 border-b border-white/12 py-3">
          <span class="aspect-video w-24 shrink-0 rounded-module bg-surface-elevated motion-safe:animate-shimmer" />
          <span class="flex flex-1 flex-col gap-2">
            <span class="h-3 w-11/12 rounded-[1px] bg-surface-elevated motion-safe:animate-shimmer" />
            <span class="h-3 w-2/3 rounded-[1px] bg-surface-elevated motion-safe:animate-shimmer" />
            <span class="h-2 w-1/3 rounded-[1px] bg-surface-elevated motion-safe:animate-shimmer" />
          </span>
        </li>
      </ul>

      <ul v-else-if="searchState === 'results'" class="pt-1" aria-label="Search results">
        <li v-for="song in results" :key="song.videoId" class="flex items-center gap-3 border-b border-white/12 py-3">
          <img
            :src="song.thumbnail"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            class="aspect-video w-24 shrink-0 rounded-module bg-surface-elevated object-cover"
          />
          <div class="min-w-0 flex-1">
            <p class="line-clamp-2 text-sm leading-snug font-semibold">{{ cleanTitle(song.title) }}</p>
            <p class="mt-1 flex gap-2 font-mono text-[11px] tracking-widest text-white/70 uppercase">
              <span class="tabular-nums">{{ formatDuration(song.duration) }}</span>
              <span class="truncate">{{ song.channel }}</span>
            </p>
            <p v-if="queueRequests.get(song.videoId) === 'failed'" class="mt-1 font-mono text-[11px] tracking-widest text-neon-coral uppercase">
              Couldn't queue — tap retry
            </p>
          </div>
          <button
            type="button"
            class="flex h-11 min-w-[5.5rem] shrink-0 items-center justify-center gap-1 rounded-full border px-2.5 font-mono text-[11px] font-bold tracking-widest uppercase transition-colors duration-200 active:translate-y-px"
            :class="{
              'border-white/25 bg-surface text-white active:bg-surface-elevated': !queueRequests.has(song.videoId),
              'border-acid-lime bg-acid-lime text-obsidian': queueRequests.get(song.videoId) === 'pending' || queueRequests.get(song.videoId) === 'queued',
              'border-neon-coral text-neon-coral': queueRequests.get(song.videoId) === 'failed'
            }"
            :aria-label="`Queue ${cleanTitle(song.title)}`"
            :aria-pressed="queueRequests.get(song.videoId) === 'queued'"
            :disabled="queueRequests.get(song.videoId) === 'pending'"
            @click="requestQueue(song)"
          >
            <template v-if="queueRequests.get(song.videoId) === 'failed'">
              <RotateCw class="size-3.5" :stroke-width="2" aria-hidden="true" /> Retry
            </template>
            <template v-else-if="queueRequests.has(song.videoId)">
              <Check class="size-3.5" :stroke-width="2.25" aria-hidden="true" /> Queued
            </template>
            <template v-else>
              <Plus class="size-3.5" :stroke-width="2" aria-hidden="true" /> Queue
            </template>
          </button>
        </li>
      </ul>

      <section v-else-if="searchState === 'empty'" class="pt-10 text-center">
        <Disc3 class="mx-auto size-8 text-white/30" :stroke-width="1.5" aria-hidden="true" />
        <p class="mt-4 font-mono text-xs tracking-widest text-white/70 uppercase">No matches — try artist + title</p>
      </section>

      <section v-else class="pt-10 text-center" role="alert">
        <p class="font-mono text-xs tracking-widest text-neon-coral uppercase">Search offline — retry in a moment</p>
        <button
          type="button"
          class="mt-4 inline-flex h-11 items-center gap-2 rounded-full border border-white/25 px-5 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
          @click="searchNow"
        >
          <RotateCw class="size-3.5" :stroke-width="2" aria-hidden="true" /> Retry
        </button>
      </section>
    </main>

    <!-- UNDO TOAST (sheet closed) -->
    <div
      v-if="undoItem && !sheetOpen"
      class="fixed inset-x-0 bottom-[calc(9.75rem+env(safe-area-inset-bottom))] z-20 px-safe"
    >
      <div class="flex items-center gap-3 rounded-module border border-white/12 bg-surface-elevated py-1 pl-3">
        <p class="min-w-0 flex-1 truncate font-mono text-[11px] tracking-widest text-white/80 uppercase">
          Removed // {{ cleanTitle(undoItem.title) }}
        </p>
        <button type="button" class="flex h-11 items-center gap-1.5 px-3 font-mono text-[11px] font-bold tracking-widest text-acid-lime uppercase" @click="undoRemoval">
          <Undo2 class="size-3.5" :stroke-width="2" aria-hidden="true" /> Undo
        </button>
      </div>
    </div>

    <!-- STICKY TRANSPORT DECK -->
    <footer class="fixed inset-x-0 bottom-0 z-10 border-t border-white/12 bg-surface px-safe pt-3 pb-safe">
      <div class="flex items-center gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-module border border-white/12 bg-obsidian text-base">
          <EqualizerBadge v-if="hasSong" :active="!store.isPaused" />
          <Disc3 v-else class="size-4 text-white/50" :stroke-width="ICON_STROKE" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="font-mono text-[10px] tracking-widest uppercase" :class="!hasSong ? 'text-white/70' : store.isPaused ? 'text-vinyl-amber' : 'text-acid-lime'">
            {{ !hasSong ? 'Stage idle' : store.isPaused ? 'Paused' : 'On air' }}<template v-if="store.currentSong"> // {{ store.currentSong.singer }}</template>
          </p>
          <p class="truncate text-sm font-semibold">
            {{ store.currentSong ? cleanTitle(store.currentSong.title) : 'Queue a track to start the set' }}
          </p>
        </div>
      </div>

      <div class="mt-3 grid grid-cols-[1fr_1fr_1fr_1.35fr] gap-2" role="group" aria-label="Playback controls">
        <button
          type="button"
          class="grid h-13 place-items-center rounded-key border border-white/12 bg-surface-elevated text-white active:translate-y-px active:bg-obsidian disabled:opacity-35"
          aria-label="Restart track"
          :disabled="transportDisabled"
          @click="transport('restart')"
        >
          <RotateCcw class="size-5" :stroke-width="ICON_STROKE" />
        </button>
        <button
          type="button"
          class="grid h-13 place-items-center rounded-key border border-acid-lime bg-acid-lime text-obsidian active:translate-y-px active:brightness-90 disabled:border-white/12 disabled:bg-surface-elevated disabled:text-white/35"
          :aria-label="store.isPaused ? 'Resume' : 'Pause'"
          :disabled="transportDisabled"
          @click="transport('toggle_pause')"
        >
          <Play v-if="store.isPaused" class="size-5" :stroke-width="2" fill="currentColor" />
          <Pause v-else class="size-5" :stroke-width="2" fill="currentColor" />
        </button>
        <button
          type="button"
          class="grid h-13 place-items-center rounded-key border border-white/12 bg-surface-elevated text-white active:translate-y-px active:bg-obsidian disabled:opacity-35"
          aria-label="Skip track"
          :disabled="transportDisabled"
          @click="transport('skip')"
        >
          <SkipForward class="size-5" :stroke-width="ICON_STROKE" />
        </button>
        <button
          type="button"
          class="flex h-13 items-center justify-center gap-2 rounded-key border border-white/12 bg-obsidian font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
          aria-haspopup="dialog"
          :aria-expanded="sheetOpen"
          @click="openQueueSheet"
        >
          <ListMusic class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" />
          Queue
          <span class="rounded-[2px] bg-white/10 px-1 tabular-nums">{{ String(visibleQueue.length).padStart(2, '0') }}</span>
        </button>
      </div>
    </footer>

    <!-- QUEUE SHEET -->
    <dialog
      ref="queueSheet"
      closedby="any"
      aria-labelledby="queue-sheet-title"
      class="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none translate-y-0 overflow-y-auto rounded-t-[6px] border-t border-white/12 bg-surface p-0 text-white transition-transform duration-300 ease-out motion-reduce:transition-none starting:open:translate-y-full"
      @close="sheetOpen = false"
      @click="onSheetClick"
    >
      <div class="sticky top-0 z-10 border-b border-white/12 bg-surface px-safe pt-2 pb-3">
        <div class="mx-auto h-1 w-10 rounded-full bg-white/25" aria-hidden="true" />
        <div class="mt-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="queue-sheet-title" class="font-display text-2xl leading-none font-extrabold tracking-tighter uppercase">Setlist</h2>
            <p class="mt-1 font-mono text-[11px] tracking-widest text-white/70 uppercase">
              Fair rotation // {{ String(visibleQueue.length).padStart(2, '0') }} up next
            </p>
          </div>
          <button
            type="button"
            class="grid size-11 place-items-center rounded-key border border-white/12 active:translate-y-px active:bg-surface-elevated"
            aria-label="Close setlist"
            @click="queueSheet?.close()"
          >
            <X class="size-5" :stroke-width="ICON_STROKE" />
          </button>
        </div>
      </div>

      <div class="px-safe pb-safe">
        <div v-if="store.currentSong" class="mt-3 flex items-center gap-3 rounded-module border border-acid-lime/40 bg-obsidian p-3">
          <EqualizerBadge :active="!store.isPaused" class="text-lg" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ cleanTitle(store.currentSong.title) }}</p>
            <p class="truncate font-mono text-[11px] tracking-widest text-acid-lime uppercase">{{ store.currentSong.singer }}</p>
          </div>
          <StatusBadge :item="store.currentSong" />
        </div>

        <ol v-if="visibleQueue.length" class="mt-1">
          <li v-for="(item, index) in visibleQueue" :key="item.id" class="flex items-center gap-3 border-b border-white/12 py-3">
            <span class="w-6 shrink-0 font-mono text-xs text-white/70 tabular-nums">{{ formatIndex(index) }}</span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ cleanTitle(item.title) }}</p>
              <p class="mt-0.5 flex items-center gap-2">
                <span class="truncate font-mono text-[11px] tracking-widest text-acid-lime uppercase">{{ item.singer }}</span>
                <StatusBadge :item="item" />
              </p>
              <p v-if="item.status === 'error' && item.errorMessage" class="mt-1 truncate font-mono text-[10px] tracking-wider text-neon-coral uppercase">
                {{ item.errorMessage }}
              </p>
            </div>
            <button
              type="button"
              class="ml-2 grid size-11 shrink-0 place-items-center rounded-key border border-white/12 text-neon-coral active:translate-y-px active:bg-surface-elevated"
              :aria-label="`Remove ${cleanTitle(item.title)}`"
              @click="scheduleRemoval(item)"
            >
              <Trash2 class="size-4" :stroke-width="ICON_STROKE" />
            </button>
          </li>
        </ol>
        <p v-else class="py-10 text-center font-mono text-xs tracking-widest text-white/70 uppercase">
          Queue is empty. Be the first on the mic.
        </p>

        <div v-if="undoItem" class="sticky bottom-0 mt-3 flex items-center gap-3 rounded-module border border-white/12 bg-surface-elevated py-1 pl-3">
          <p class="min-w-0 flex-1 truncate font-mono text-[11px] tracking-widest text-white/80 uppercase">
            Removed // {{ cleanTitle(undoItem.title) }}
          </p>
          <button type="button" class="flex h-11 items-center gap-1.5 px-3 font-mono text-[11px] font-bold tracking-widest text-acid-lime uppercase" @click="undoRemoval">
            <Undo2 class="size-3.5" :stroke-width="2" aria-hidden="true" /> Undo
          </button>
        </div>
      </div>
    </dialog>

    <!-- STAGE NAME PROMPT (first queue action) -->
    <dialog
      ref="nameSheet"
      closedby="any"
      aria-labelledby="name-sheet-title"
      class="fixed inset-x-0 top-auto bottom-0 m-0 w-full max-w-none rounded-t-[6px] border-t border-white/12 bg-surface p-0 text-white transition-transform duration-300 ease-out motion-reduce:transition-none starting:open:translate-y-full"
      @close="onNameSheetClose"
      @click="onSheetClick"
    >
      <form class="px-safe pt-5 pb-safe" @submit.prevent="submitNameSheet">
        <p class="font-mono text-[11px] tracking-widest text-white/70 uppercase">Before you queue</p>
        <h2 id="name-sheet-title" class="mt-1 font-display text-3xl leading-none font-extrabold tracking-tighter uppercase">
          Your stage <span class="text-acid-lime">name</span>
        </h2>
        <label for="name-sheet-input" class="mt-5 block font-mono text-[11px] tracking-widest text-white/70 uppercase">Shown on the TV when it's your turn</label>
        <input
          id="name-sheet-input"
          v-model="nameSheetDraft"
          :maxlength="MAX_SINGER_NAME_LENGTH"
          class="mt-2 h-12 w-full rounded-key border border-white/12 bg-obsidian px-3 text-base font-semibold placeholder:text-white/50 focus:border-acid-lime focus:outline-none"
          placeholder="e.g. Midnight Mel"
          autocomplete="nickname"
          autocapitalize="words"
          enterkeyhint="done"
          autofocus
        />
        <div class="mt-4 mb-1 grid grid-cols-[auto_1fr] gap-2">
          <button
            type="button"
            class="h-12 rounded-key border border-white/12 px-4 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
            @click="nameSheet?.close()"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="h-12 rounded-key bg-acid-lime font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px active:brightness-90 disabled:bg-surface-elevated disabled:text-white/35"
            :disabled="!nameSheetDraft.trim()"
          >
            {{ pendingSong ? 'Save + queue' : 'Save' }}
          </button>
        </div>
      </form>
    </dialog>

    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </div>
</template>
