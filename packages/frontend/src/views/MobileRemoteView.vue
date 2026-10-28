<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Disc3,
  Gamepad2,
  GripVertical,
  KeyRound,
  ListMusic,
  Link2,
  Lock,
  MicVocal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  ShieldCheck,
  SkipForward,
  Square,
  Trash2,
  Undo2,
  UserPen,
  X
} from 'lucide-vue-next';
import type { PlaybackCommand, QueueItem, SearchResult } from '@singpulse/shared/types';
import { useKaraokeStore } from '../stores/karaoke.ts';
import { MAX_SINGER_NAME_LENGTH, useSingerName } from '../lib/singerName.ts';
import { cleanTitle, formatDuration, formatIndex } from '../lib/format.ts';
import EqualizerBadge from '../components/EqualizerBadge.vue';
import StatusBadge from '../components/StatusBadge.vue';
import CrowdVoteSheet from '../components/CrowdVoteSheet.vue';
import TriviaBanner from '../components/TriviaBanner.vue';
import TriviaSheet from '../components/TriviaSheet.vue';
import { TRIVIA_CATEGORIES, TRIVIA_DIFFICULTIES } from '../lib/trivia.ts';
import type { TriviaCategoryKey, TriviaDifficulty } from '@singpulse/shared/types';
import PolaroidCamera from '../components/PolaroidCamera.vue';
import InstallCard from '../components/InstallCard.vue';
import RejoinPanel from '../components/RejoinPanel.vue';
import { usePwaUpdates } from '../lib/pwa.ts';
import { useRoute, useRouter } from 'vue-router';
import { consumeLaunchParams, hasLaunchParams, readLaunchParams, type LaunchParams } from '../lib/launchParams.ts';
import { useSheetDrag } from '../lib/sheetDrag.ts';

const SEARCH_DEBOUNCE_MS = 350;
const UNDO_WINDOW_MS = 5000;
const ICON_STROKE = 1.75;

const store = useKaraokeStore();
const route = useRoute();
const router = useRouter();
const { singerName, save: saveSingerName } = useSingerName();
usePwaUpdates();

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
const searchInput = ref<HTMLInputElement | null>(null);
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
    window.scrollTo({ top: 0 });
  } catch {
    if (controller.signal.aborted) return;
    searchState.value = 'error';
  }
}

function searchNow(): void {
  searchInput.value?.blur();
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

/* ------------------------------------------------------------ shared link */
// A YouTube link shared into the app (Android share target) is pinned above the karaoke search
const sharedSong = ref<SearchResult | null>(null);
const listedResults = computed(() =>
  sharedSong.value ? [sharedSong.value, ...results.value.filter((song) => song.videoId !== sharedSong.value?.videoId)] : results.value
);
const showList = computed(() => searchState.value === 'results' || (sharedSong.value !== null && searchState.value !== 'loading'));

async function openSharedLink(videoId: string, fallbackText: string): Promise<void> {
  query.value = fallbackText;
  try {
    const song = await store.lookupVideo(videoId);
    sharedSong.value = song;
    query.value = cleanTitle(song.title);
    announce(`Shared link found: ${cleanTitle(song.title)}`);
  } catch {
    // Lookup failed: the shared title (if the share sheet sent one) still drives a karaoke search
    sharedSong.value = null;
    if (fallbackText) announce(`Link lookup failed. Searching for ${fallbackText}`);
    else announce('Could not read the shared link');
  }
}

function applyLaunch(launch: LaunchParams): void {
  if (launch.videoId) void openSharedLink(launch.videoId, launch.text);
  else if (launch.text) query.value = launch.text;
  if (launch.action === 'search') void nextTick(() => searchInput.value?.focus());
  else if (launch.action === 'setlist') void nextTick(openQueueSheet);
}

// Warm launches (shortcut or share while the app is already open) may only change the query
watch(
  () => route.query,
  (next) => {
    if (!hasLaunchParams(next)) return;
    applyLaunch(consumeLaunchParams());
    const { action: _a, share_title: _t, share_text: _x, share_url: _u, ...rest } = next;
    void router.replace({ query: rest });
  }
);

type LaunchQueueWindow = Window & {
  launchQueue?: { setConsumer: (cb: (params: { targetURL?: string }) => void) => void };
};

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

// Host drags show the new order immediately; the server broadcast then confirms it
const orderOverride = ref<string[] | null>(null);
const displayQueue = computed(() => {
  const order = orderOverride.value;
  if (!order) return visibleQueue.value;
  const rank = new Map(order.map((id, i) => [id, i]));
  return visibleQueue.value.toSorted((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
});
watch(() => store.queue, () => (orderOverride.value = null));

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

/* --------------------------------------------------------------- host mode */
const pinSheet = ref<HTMLDialogElement | null>(null);
const pinDraft = ref('');
const pinError = ref('');
const pinBusy = ref(false);

function onHostButton(): void {
  if (store.isAdmin) {
    openQueueSheet();
    return;
  }
  pinDraft.value = '';
  pinError.value = '';
  pinSheet.value?.showModal();
}

async function submitPin(): Promise<void> {
  if (!pinDraft.value || pinBusy.value) return;
  pinBusy.value = true;
  pinError.value = '';
  try {
    if (await store.unlockAdmin(pinDraft.value)) {
      pinSheet.value?.close();
      announce('Host mode unlocked');
    } else {
      pinError.value = 'Wrong PIN';
      pinDraft.value = '';
      navigator.vibrate?.([30, 40, 30]);
    }
  } catch {
    pinError.value = 'Host unreachable — retry';
  } finally {
    pinBusy.value = false;
  }
}

function lockHost(): void {
  store.lockAdmin();
  queueSheet.value?.close();
  announce('Host mode locked');
}

const hostError = ref('');

async function setFairQueue(): Promise<void> {
  hostError.value = '';
  try {
    await store.toggleFairQueue(!store.fairQueueEnabled);
    announce(`Round robin fair queue ${store.fairQueueEnabled ? 'active' : 'bypassed'}`);
  } catch {
    hostError.value = 'Switch failed — retry';
  }
}

// Two-tap guard: rotation kicks every guest, so the first tap only arms it
const rotateArmed = ref(false);
const rotateBusy = ref(false);
const rotatedTo = ref('');
let rotateArmTimer: ReturnType<typeof setTimeout> | null = null;
let rotatedToTimer: ReturnType<typeof setTimeout> | null = null;

async function onRotate(): Promise<void> {
  if (rotateBusy.value) return;
  if (!rotateArmed.value) {
    rotateArmed.value = true;
    rotateArmTimer = setTimeout(() => (rotateArmed.value = false), 4000);
    return;
  }
  if (rotateArmTimer) clearTimeout(rotateArmTimer);
  rotateArmed.value = false;
  rotateBusy.value = true;
  hostError.value = '';
  try {
    rotatedTo.value = await store.rotatePartyToken();
    navigator.vibrate?.(20);
    announce('Party code rotated. Guests were disconnected.');
    if (rotatedToTimer) clearTimeout(rotatedToTimer);
    rotatedToTimer = setTimeout(() => (rotatedTo.value = ''), 10000);
  } catch {
    hostError.value = 'Rotation failed — retry';
  } finally {
    rotateBusy.value = false;
  }
}

async function vetoItem(item: QueueItem): Promise<void> {
  try {
    await store.vetoSong(item.id);
    announce(`Vetoed ${cleanTitle(item.title)}`);
  } catch {
    announce(`Could not veto ${cleanTitle(item.title)}`);
  }
}

// Host row actions live in a 44px key strip under the tapped row
const expandedId = ref<string | null>(null);
function toggleExpanded(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
}

const editingSingerId = ref<string | null>(null);
const singerDraft = ref('');

function startSingerEdit(item: QueueItem): void {
  expandedId.value = null;
  editingSingerId.value = item.id;
  singerDraft.value = item.singer;
  void nextTick(() => document.getElementById('singer-edit')?.focus());
}

async function saveSingerEdit(item: QueueItem): Promise<void> {
  const next = singerDraft.value.trim().slice(0, MAX_SINGER_NAME_LENGTH);
  editingSingerId.value = null;
  if (!next || next === item.singer) return;
  try {
    await store.renameSongSinger(item.id, next);
    announce(`Singer renamed to ${next}`);
  } catch {
    announce('Could not rename singer');
  }
}

/* Pointer-driven drag reordering: no dependency, touch-action is pinned on the grip only */
interface DragState {
  id: string;
  pointerId: number;
  from: number;
  target: number;
  startY: number;
  dy: number;
  height: number;
  mids: number[];
}
const drag = ref<DragState | null>(null);
const rowEls = new Map<string, HTMLElement>();

function setRowEl(id: string, el: unknown): void {
  if (el instanceof HTMLElement) rowEls.set(id, el);
  else rowEls.delete(id);
}

function startDrag(event: PointerEvent, id: string, index: number): void {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const rects = displayQueue.value.map((item) => rowEls.get(item.id)?.getBoundingClientRect());
  drag.value = {
    id,
    pointerId: event.pointerId,
    from: index,
    target: index,
    startY: event.clientY,
    dy: 0,
    height: rects[index]?.height ?? 0,
    mids: rects.map((r) => (r ? r.top + r.height / 2 : 0))
  };
  navigator.vibrate?.(10);
}

function moveDrag(event: PointerEvent): void {
  const d = drag.value;
  if (!d || event.pointerId !== d.pointerId) return;
  d.dy = event.clientY - d.startY;
  const center = (d.mids[d.from] ?? 0) + d.dy;
  d.target = d.mids.filter((mid, i) => i !== d.from && mid < center).length;
}

function endDrag(event: PointerEvent): void {
  const d = drag.value;
  if (!d || event.pointerId !== d.pointerId) return;
  drag.value = null;
  void commitReorder(d.from, d.target);
}

function rowStyle(id: string, index: number): Record<string, string> | undefined {
  const d = drag.value;
  if (!d) return undefined;
  if (id === d.id) return { transform: `translateY(${d.dy}px)`, zIndex: '1', position: 'relative' };
  if (d.from < index && index <= d.target) return { transform: `translateY(${-d.height}px)` };
  if (d.target <= index && index < d.from) return { transform: `translateY(${d.height}px)` };
  return undefined;
}

function onGripKey(event: KeyboardEvent, index: number): void {
  const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!step) return;
  event.preventDefault();
  const to = index + step;
  if (to < 0 || to >= displayQueue.value.length) return;
  void commitReorder(index, to).then(() => {
    void nextTick(() => document.getElementById(`grip-${displayQueue.value[to]?.id}`)?.focus());
  });
}

async function commitReorder(from: number, to: number): Promise<void> {
  if (from === to) return;
  const list = displayQueue.value;
  const moved = list[from];
  const anchor = list[to];
  if (!moved || !anchor) return;
  const ids = list.map((item) => item.id);
  ids.splice(from, 1);
  ids.splice(to, 0, moved.id);
  orderOverride.value = ids;
  // The server index is into the full queue, which may hold items pending undo
  const serverIndex = store.queue.findIndex((item) => item.id === anchor.id);
  try {
    await store.reorderQueue(moved.id, serverIndex);
    announce(`Moved ${cleanTitle(moved.title)} to position ${to + 1}`);
  } catch {
    orderOverride.value = null;
    announce('Could not reorder the queue');
  }
}

/* ------------------------------------------------------------------ sheets */
const polaroidCamera = ref<InstanceType<typeof PolaroidCamera> | null>(null);
const queueSheet = ref<HTMLDialogElement | null>(null);
const nameSheet = ref<HTMLDialogElement | null>(null);
const sheetOpen = ref(false);
const queueDrag = useSheetDrag(queueSheet);
const nameDrag = useSheetDrag(nameSheet);
const pinDrag = useSheetDrag(pinSheet);
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
  pendingTriviaJoin.value = false;
}

function submitNameSheet(): void {
  if (!saveSingerName(nameSheetDraft.value)) return;
  editingName.value = false;
  const song = pendingSong.value;
  const joinTrivia = pendingTriviaJoin.value;
  nameSheet.value?.close();
  if (song) void queueSong(song);
  if (joinTrivia) void joinTriviaGame();
}

/* ------------------------------------------------------------------ trivia */
const pendingTriviaJoin = ref(false);

async function joinTriviaGame(): Promise<void> {
  try {
    if ((await store.joinTrivia()) === 'needs-name') {
      pendingTriviaJoin.value = true;
      openNameSheet();
      return;
    }
    navigator.vibrate?.(10);
    announce('Joined Trivia Blitz');
  } catch {
    announce('Could not join Trivia Blitz. Tap join to retry.');
  }
}

const triviaCategory = ref<TriviaCategoryKey>('MUSIC');
const triviaDifficulty = ref<TriviaDifficulty>('mixed');
const triviaRounds = ref<5 | 10>(5);
const triviaBusy = ref(false);

async function hostTrivia(action: () => Promise<void>): Promise<void> {
  if (triviaBusy.value) return;
  triviaBusy.value = true;
  hostError.value = '';
  try {
    await action();
  } catch (err) {
    const status = /\((\d+)\)/.exec(err instanceof Error ? err.message : '')?.[1];
    hostError.value =
      status === '409' ? 'Stage busy — end the song or vote first'
        : status === '400' ? 'Waiting for at least 1 player to join'
          : 'Trivia request failed — retry';
  } finally {
    triviaBusy.value = false;
  }
}

const openLobby = () => hostTrivia(() => store.openTriviaLobby(triviaCategory.value, triviaDifficulty.value, triviaRounds.value));
const startTrivia = () => hostTrivia(() => store.startTriviaGame());
const endTrivia = () => hostTrivia(() => store.stopTriviaGame());

/* --------------------------------------------------------------- lifecycle */
const deckEl = ref<HTMLElement | null>(null);
const deckHeight = ref(0);
const keyboardUp = ref(false);
let deckObserver: ResizeObserver | null = null;
let focusedAt = 0;
let focusScrollY = 0;

function isTextField(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && !['button', 'submit', 'checkbox', 'radio', 'file'].includes(el.type);
}

function syncKeyboard(): void {
  const vv = window.visualViewport;
  const typing = isTextField(document.activeElement);
  keyboardUp.value = typing && vv !== null && vv.height < window.innerHeight * 0.75;
}

function onFocusIn(event: FocusEvent): void {
  if (event.target === searchInput.value) {
    focusedAt = performance.now();
    focusScrollY = window.scrollY;
  }
  syncKeyboard();
}

// Blur on a real scroll, never on touchstart: a mid-tap viewport shift would eat QUEUE clicks.
// iOS scrolls the field into view on focus, so ignore the first 400ms and small drifts.
function onScrollBlur(): void {
  const input = searchInput.value;
  if (!input || document.activeElement !== input) return;
  if (performance.now() - focusedAt < 400 || Math.abs(window.scrollY - focusScrollY) < 24) return;
  input.blur();
}

onMounted(() => {
  store.connect();
  if (deckEl.value) {
    deckObserver = new ResizeObserver(([entry]) => {
      deckHeight.value = Math.ceil(entry?.borderBoxSize?.[0]?.blockSize ?? deckEl.value?.offsetHeight ?? 0);
    });
    deckObserver.observe(deckEl.value);
  }
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', syncKeyboard);
  window.visualViewport?.addEventListener('resize', syncKeyboard);
  window.addEventListener('scroll', onScrollBlur, { passive: true });

  applyLaunch(consumeLaunchParams());
  // Chromium hands warm launches to the open window here instead of reloading it
  (window as LaunchQueueWindow).launchQueue?.setConsumer(({ targetURL }) => {
    if (!targetURL) return;
    try {
      const url = new URL(targetURL);
      if (url.origin === window.location.origin) applyLaunch(readLaunchParams(url));
    } catch {
      // Malformed target: ignore
    }
  });
  void store.restoreAdmin();
  window.addEventListener('pagehide', flushRemovals);
  // First run: surface the name field without focusing it (no surprise keyboard)
  editingName.value = !singerName.value;
});

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  searchController?.abort();
  window.removeEventListener('pagehide', flushRemovals);
  deckObserver?.disconnect();
  document.removeEventListener('focusin', onFocusIn);
  document.removeEventListener('focusout', syncKeyboard);
  window.visualViewport?.removeEventListener('resize', syncKeyboard);
  window.removeEventListener('scroll', onScrollBlur);
  if (rotateArmTimer) clearTimeout(rotateArmTimer);
  if (rotatedToTimer) clearTimeout(rotatedToTimer);
  flushRemovals();
});

const skeletonRows = 6;
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-obsidian text-white" :style="{ '--deck-h': deckHeight ? `${deckHeight}px` : '10.5rem' }">
    <!-- Covers the status-bar inset while the search is pinned (standalone, translucent bar) -->
    <div class="fixed inset-x-0 top-0 z-20 h-[env(safe-area-inset-top)] bg-obsidian" aria-hidden="true" />

    <!-- TOP BAR: brand, link state, identity (scrolls away; only the search stays pinned) -->
    <header class="px-safe pt-safe">
      <div class="flex flex-wrap items-center justify-between gap-x-3">
        <p class="flex items-baseline gap-2">
          <span class="font-display text-xl leading-none font-extrabold tracking-tighter uppercase">
            Sing<span class="text-acid-lime">Pulse</span>
          </span>
          <span class="font-mono text-[11px] tracking-widest whitespace-nowrap text-white/70 uppercase max-[430px]:hidden">// Remote</span>
        </p>
        <div class="-my-2 ml-auto flex shrink-0 items-center gap-1">
          <p class="flex items-center gap-1.5 font-mono text-[11px] tracking-widest whitespace-nowrap uppercase" role="status">
            <span
              class="size-1.5 rounded-full"
              :class="store.connected && store.online ? 'bg-acid-lime' : 'bg-vinyl-amber motion-safe:animate-shimmer'"
              aria-hidden="true"
            />
            <span :class="store.connected && store.online ? 'text-white/70 max-[380px]:sr-only' : 'text-vinyl-amber'">{{
              !store.online ? 'OFFLINE' : store.connected ? 'LINK OK' : 'RECONNECTING'
            }}</span>
          </p>
          <PolaroidCamera ref="polaroidCamera" @announce="announce" />
          <button
            v-if="store.isAdmin"
            type="button"
            class="px-1 font-mono text-[11px] font-bold tracking-widest text-white/70 uppercase active:text-acid-lime"
            aria-label="Manage saved photos"
            @click="polaroidCamera?.openWall()"
          >
            Wall {{ String(store.polaroids.length).padStart(2, '0') }}
          </button>
          <button
            type="button"
            class="flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-key px-2 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
            :class="store.isAdmin ? 'text-acid-lime' : 'text-white/70'"
            :aria-label="store.isAdmin ? 'Open host controls' : 'Unlock host mode'"
            @click="onHostButton"
          >
            <ShieldCheck v-if="store.isAdmin" class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" />
            <Lock v-else class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" />
            <span v-if="store.isAdmin" class="rounded-[2px] bg-acid-lime px-1 text-obsidian">Host</span>
          </button>
        </div>
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

    </header>

    <form role="search" class="sticky top-0 z-10 border-b border-white/12 bg-obsidian px-safe pt-2 pb-3" @submit.prevent="searchNow">
      <TriviaBanner class="mb-2" @join="joinTriviaGame" @announce="announce" />
      <div class="relative">
        <label for="song-search" class="sr-only">Search songs</label>
        <Search
          class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-white/70"
          :stroke-width="ICON_STROKE"
          aria-hidden="true"
        />
        <input
          id="song-search"
          ref="searchInput"
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
      </div>
    </form>

    <!-- RESULTS -->
    <main class="flex-1 px-safe pb-[calc(var(--deck-h)+1rem)]">
      <ul v-if="showList" class="pt-1" aria-label="Search results">
        <li v-for="song in listedResults" :key="song.videoId" class="flex items-center gap-3 border-b border-white/12 py-3">
          <img
            :src="song.thumbnail"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            class="aspect-video w-24 shrink-0 rounded-module bg-surface-elevated object-cover"
          />
          <div class="min-w-0 flex-1">
            <p v-if="song.videoId === sharedSong?.videoId" class="mb-0.5 flex items-center gap-1 font-mono text-[10px] tracking-widest text-acid-lime uppercase">
              <Link2 class="size-3" :stroke-width="ICON_STROKE" aria-hidden="true" /> Shared link
            </p>
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

      <section v-else-if="searchState === 'idle'" class="pt-8" aria-label="Get started">
        <p class="font-mono text-[11px] tracking-widest text-white/70 uppercase">Ready when you are</p>
        <h1 class="mt-2 font-display text-4xl leading-[0.9] short:text-3xl font-extrabold tracking-tighter uppercase">
          Find your<br /><span class="text-acid-lime">song</span>
        </h1>
        <ul class="mt-6 space-y-2.5 border-t border-white/12 pt-4 font-mono text-[11px] tracking-widest text-white/70 uppercase">
          <li class="flex gap-3"><span class="text-acid-lime">01</span>Search artist + title</li>
          <li class="flex gap-3"><span class="text-acid-lime">02</span>Tap queue. We add “karaoke” for you</li>
          <li class="flex gap-3"><span class="text-acid-lime">03</span>Fair rotation: everyone gets a turn</li>
        </ul>
        <InstallCard />
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
      class="fixed inset-x-0 bottom-[calc(var(--deck-h)+0.5rem)] z-20 px-safe"
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
    <footer
      ref="deckEl"
      class="fixed inset-x-0 bottom-0 z-10 border-t border-white/12 bg-surface px-safe pt-3 pb-safe transition-transform duration-200 motion-reduce:transition-none short:flex short:items-center short:gap-3 short:pt-2"
      :class="keyboardUp ? 'translate-y-full' : ''"
    >
      <div class="flex items-center gap-3 short:min-w-0 short:flex-1">
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

      <div class="mt-3 grid grid-cols-[1fr_1fr_1fr_1.35fr] gap-2 short:mt-0 short:w-[26rem] short:shrink-0" role="group" aria-label="Playback controls">
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
      class="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none translate-y-0 overflow-y-auto short:max-h-[92dvh] rounded-t-[6px] border-t border-white/12 bg-surface p-0 text-white transition-transform duration-300 ease-out motion-reduce:transition-none starting:open:translate-y-full"
      @close="sheetOpen = false"
      @click="onSheetClick"
    >
      <div class="sticky top-0 z-10 border-b border-white/12 bg-surface px-safe pt-2 pb-3">
        <div class="-mt-2 flex h-6 touch-none items-center" v-bind="queueDrag.dragHandlers" aria-hidden="true">
          <div class="mx-auto h-1 w-10 rounded-full bg-white/25" />
        </div>
        <div class="mt-1 flex items-center justify-between gap-3">
          <div>
            <h2 id="queue-sheet-title" class="font-display text-2xl leading-none font-extrabold tracking-tighter uppercase">Setlist</h2>
            <p class="mt-1 font-mono text-[11px] tracking-widest text-white/70 uppercase">
              {{ store.fairQueueEnabled ? 'Fair rotation' : 'Arrival order' }} // {{ String(visibleQueue.length).padStart(2, '0') }} up next
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

        <!-- HOST CONTROL STRIP -->
        <section v-if="store.isAdmin" class="mt-3 rounded-module border border-acid-lime/40 bg-obsidian" aria-label="Host controls">
          <div class="flex items-center justify-between border-b border-white/12 px-3 py-1">
            <p class="flex items-center gap-2 font-mono text-[11px] font-bold tracking-widest text-acid-lime uppercase">
              <ShieldCheck class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Host mode
            </p>
            <button
              type="button"
              class="flex h-11 items-center gap-1.5 px-1 font-mono text-[11px] tracking-widest text-white/70 uppercase active:text-white"
              @click="lockHost"
            >
              <Lock class="size-3.5" :stroke-width="ICON_STROKE" aria-hidden="true" /> Lock
            </button>
          </div>


          <!-- TRIVIA BLITZ launcher -->
          <div class="border-b border-white/12 px-3 py-3" aria-label="Trivia Blitz">
            <p class="flex items-center gap-2 font-mono text-[11px] font-bold tracking-widest uppercase">
              <Gamepad2 class="size-4 text-acid-lime" :stroke-width="ICON_STROKE" aria-hidden="true" /> Trivia blitz
              <span v-if="store.activeTrivia" class="ml-auto text-acid-lime">{{ store.activeTrivia.phase }} // {{ store.activeTrivia.players.length }} IN</span>
            </p>
            <template v-if="!store.activeTrivia">
              <div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Category">
                <button
                  v-for="c in TRIVIA_CATEGORIES"
                  :key="c.key"
                  type="button"
                  class="h-11 rounded-full border px-3 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px"
                  :class="triviaCategory === c.key ? 'border-acid-lime bg-acid-lime text-obsidian' : 'border-white/25 text-white/80'"
                  :aria-pressed="triviaCategory === c.key"
                  @click="triviaCategory = c.key"
                >
                  {{ c.label }}
                </button>
              </div>
              <div class="mt-2 flex gap-2">
                <div class="flex flex-1 gap-1" role="group" aria-label="Difficulty">
                  <button
                    v-for="d in TRIVIA_DIFFICULTIES"
                    :key="d.key"
                    type="button"
                    class="h-11 flex-1 rounded-key border font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px"
                    :class="triviaDifficulty === d.key ? 'border-acid-lime text-acid-lime' : 'border-white/25 text-white/70'"
                    :aria-pressed="triviaDifficulty === d.key"
                    @click="triviaDifficulty = d.key"
                  >
                    {{ d.label }}
                  </button>
                </div>
                <div class="flex gap-1" role="group" aria-label="Rounds">
                  <button
                    v-for="n in ([5, 10] as const)"
                    :key="n"
                    type="button"
                    class="h-11 w-12 rounded-key border font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px"
                    :class="triviaRounds === n ? 'border-acid-lime text-acid-lime' : 'border-white/25 text-white/70'"
                    :aria-pressed="triviaRounds === n"
                    @click="triviaRounds = n"
                  >
                    {{ n }}Q
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="mt-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-key bg-acid-lime font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px disabled:opacity-50"
                :disabled="triviaBusy"
                @click="openLobby"
              >
                Open lobby
              </button>
            </template>
            <div v-else class="mt-2 flex gap-2">
              <button
                v-if="store.activeTrivia.phase === 'LOBBY'"
                type="button"
                class="min-h-12 flex-1 rounded-key bg-acid-lime font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px disabled:opacity-50"
                :disabled="triviaBusy || store.activeTrivia.players.length === 0"
                @click="startTrivia"
              >
                Start now ({{ store.activeTrivia.players.length }})
              </button>
              <button
                type="button"
                class="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-key border border-neon-coral font-mono text-[11px] font-bold tracking-widest text-neon-coral uppercase active:translate-y-px disabled:opacity-50"
                :disabled="triviaBusy"
                @click="endTrivia"
              >
                <Square class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> End trivia
              </button>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            :aria-checked="store.fairQueueEnabled"
            class="flex min-h-14 w-full items-center gap-3 border-b border-white/12 px-3 text-left active:bg-surface-elevated"
            @click="setFairQueue"
          >
            <span class="min-w-0 flex-1">
              <span class="block font-mono text-[11px] font-bold tracking-widest uppercase">Round-robin fair queue</span>
              <span
                class="block font-mono text-[10px] tracking-widest uppercase"
                :class="store.fairQueueEnabled ? 'text-acid-lime' : 'text-vinyl-amber'"
              >
                {{ store.fairQueueEnabled ? 'Active' : 'Bypassed' }}
              </span>
            </span>
            <span
              class="relative h-7 w-12 shrink-0 rounded-[3px] border transition-colors duration-200"
              :class="store.fairQueueEnabled ? 'border-acid-lime bg-acid-lime/15' : 'border-white/25 bg-surface'"
              aria-hidden="true"
            >
              <span
                class="absolute top-0.5 left-0.5 h-5 w-5 rounded-[2px] transition-transform duration-200 motion-reduce:transition-none"
                :class="store.fairQueueEnabled ? 'translate-x-5 bg-acid-lime' : 'translate-x-0 bg-white/60'"
              />
            </span>
          </button>

          <button
            type="button"
            class="flex min-h-14 w-full items-center gap-3 px-3 text-left font-mono text-[11px] font-bold tracking-widest uppercase transition-colors duration-200 active:translate-y-px disabled:opacity-50"
            :class="rotateArmed ? 'bg-neon-coral text-obsidian' : 'text-neon-coral active:bg-surface-elevated'"
            :disabled="rotateBusy"
            @click="onRotate"
          >
            <component :is="rotateArmed ? RotateCcw : KeyRound" class="size-5 shrink-0" :stroke-width="ICON_STROKE" aria-hidden="true" />
            {{ rotateBusy ? 'Rotating' : rotateArmed ? 'Tap again to kick guests & rotate QR' : 'Rotate party code' }}
          </button>

          <p v-if="rotatedTo" class="border-t border-white/12 px-3 py-2.5 font-mono text-[11px] tracking-widest text-acid-lime uppercase" role="status">
            New code // <span class="text-white normal-case">{{ rotatedTo }}</span> // QR updated
          </p>
          <p v-if="hostError" class="border-t border-white/12 px-3 py-2.5 font-mono text-[11px] tracking-widest text-neon-coral uppercase" role="alert">
            {{ hostError }}
          </p>
        </section>

        <ol v-if="displayQueue.length" class="mt-1">
          <li
            v-for="(item, index) in displayQueue"
            :key="item.id"
            :ref="(el) => setRowEl(item.id, el)"
            class="flex flex-wrap items-center gap-3 border-b border-white/12 bg-surface py-3"
            :class="[
              store.isAdmin ? 'gap-2' : '',
              drag && drag.id !== item.id ? 'motion-safe:transition-transform motion-safe:duration-150' : '',
              drag?.id === item.id ? 'border-acid-lime/60 bg-surface-elevated' : ''
            ]"
            :style="rowStyle(item.id, index)"
          >
            <button
              v-if="store.isAdmin"
              :id="`grip-${item.id}`"
              type="button"
              class="-ml-2 grid size-11 shrink-0 touch-none place-items-center rounded-key text-white/70 select-none active:bg-surface-elevated"
              :aria-label="`Reorder ${cleanTitle(item.title)}. Drag, or use up and down arrow keys.`"
              @pointerdown.prevent="startDrag($event, item.id, index)"
              @pointermove="moveDrag"
              @pointerup="endDrag"
              @pointercancel="drag = null"
              @keydown="onGripKey($event, index)"
            >
              <GripVertical class="size-5" :stroke-width="ICON_STROKE" />
            </button>
            <span class="w-6 shrink-0 font-mono text-xs text-white/70 tabular-nums">{{ formatIndex(index) }}</span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ cleanTitle(item.title) }}</p>
              <form
                v-if="store.isAdmin && editingSingerId === item.id"
                class="mt-1 flex items-center gap-1"
                @submit.prevent="saveSingerEdit(item)"
              >
                <label for="singer-edit" class="sr-only">Singer name</label>
                <input
                  id="singer-edit"
                  v-model="singerDraft"
                  :maxlength="MAX_SINGER_NAME_LENGTH"
                  class="h-11 min-w-0 flex-1 rounded-key border border-acid-lime bg-obsidian px-2 text-base font-semibold focus:outline-none"
                  enterkeyhint="done"
                  autocomplete="off"
                  @keydown.esc="editingSingerId = null"
                />
                <button type="submit" class="grid size-11 shrink-0 place-items-center text-acid-lime" aria-label="Save singer name">
                  <Check class="size-5" :stroke-width="ICON_STROKE" />
                </button>
              </form>
              <p v-else class="mt-0.5 flex items-center gap-2">
                <span class="truncate font-mono text-[11px] tracking-widest text-acid-lime uppercase">{{ item.singer }}</span>
                <StatusBadge :item="item" />
              </p>
              <p v-if="item.status === 'error' && item.errorMessage" class="mt-1 truncate font-mono text-[10px] tracking-wider text-neon-coral uppercase">
                {{ item.errorMessage }}
              </p>
            </div>
            <button
              v-if="store.isAdmin"
              type="button"
              class="ml-1 grid size-11 shrink-0 place-items-center rounded-key border text-white/80 active:translate-y-px active:bg-surface-elevated"
              :class="expandedId === item.id ? 'border-acid-lime text-acid-lime' : 'border-white/12'"
              :aria-label="`Actions for ${cleanTitle(item.title)}`"
              :aria-expanded="expandedId === item.id"
              @click="toggleExpanded(item.id)"
            >
              <ChevronUp v-if="expandedId === item.id" class="size-4" :stroke-width="ICON_STROKE" />
              <ChevronDown v-else class="size-4" :stroke-width="ICON_STROKE" />
            </button>
            <button
              v-else
              type="button"
              class="ml-2 grid size-11 shrink-0 place-items-center rounded-key border border-white/12 text-neon-coral active:translate-y-px active:bg-surface-elevated"
              :aria-label="`Remove ${cleanTitle(item.title)}`"
              @click="scheduleRemoval(item)"
            >
              <Trash2 class="size-4" :stroke-width="ICON_STROKE" />
            </button>
            <div
              v-if="store.isAdmin && expandedId === item.id"
              class="grid basis-full grid-cols-4 gap-2 pb-1 font-mono text-[10px] font-bold tracking-widest uppercase"
              role="group"
              :aria-label="`Host actions for ${cleanTitle(item.title)}`"
            >
              <button type="button" class="flex h-11 items-center justify-center gap-1 rounded-key border border-white/12 bg-surface-elevated active:translate-y-px disabled:opacity-30" :disabled="index === 0" @click="commitReorder(index, index - 1)">
                <ChevronUp class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Up
              </button>
              <button type="button" class="flex h-11 items-center justify-center gap-1 rounded-key border border-white/12 bg-surface-elevated active:translate-y-px disabled:opacity-30" :disabled="index === displayQueue.length - 1" @click="commitReorder(index, index + 1)">
                <ChevronDown class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Down
              </button>
              <button type="button" class="flex h-11 items-center justify-center gap-1 rounded-key border border-white/12 bg-surface-elevated active:translate-y-px" :aria-label="`Rename singer ${item.singer}`" @click="startSingerEdit(item)">
                <UserPen class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Name
              </button>
              <button type="button" class="flex h-11 items-center justify-center gap-1 rounded-key border border-neon-coral/60 text-neon-coral active:translate-y-px active:bg-neon-coral active:text-obsidian" @click="vetoItem(item)">
                <Trash2 class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Veto
              </button>
            </div>
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
      <div class="mx-4 flex h-8 touch-none items-center" v-bind="nameDrag.dragHandlers" aria-hidden="true">
        <div class="mx-auto h-1 w-10 rounded-full bg-white/25" />
      </div>
      <form class="px-safe pb-safe" @submit.prevent="submitNameSheet">
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

    <!-- HOST PIN -->
    <dialog
      ref="pinSheet"
      closedby="any"
      aria-labelledby="pin-sheet-title"
      class="fixed inset-x-0 top-auto bottom-0 m-0 w-full max-w-none rounded-t-[6px] border-t border-white/12 bg-surface p-0 text-white transition-transform duration-300 ease-out motion-reduce:transition-none starting:open:translate-y-full"
      @click="onSheetClick"
    >
      <div class="mx-4 flex h-8 touch-none items-center" v-bind="pinDrag.dragHandlers" aria-hidden="true">
        <div class="mx-auto h-1 w-10 rounded-full bg-white/25" />
      </div>
      <form class="px-safe pb-safe" @submit.prevent="submitPin">
        <p class="font-mono text-[11px] tracking-widest text-white/70 uppercase">Restricted // Host only</p>
        <h2 id="pin-sheet-title" class="mt-1 font-display text-3xl leading-none font-extrabold tracking-tighter uppercase">
          Host <span class="text-acid-lime">PIN</span>
        </h2>
        <label for="host-pin" class="mt-5 block font-mono text-[11px] tracking-widest text-white/70 uppercase">Unlocks queue control + party code</label>
        <input
          id="host-pin"
          v-model="pinDraft"
          type="password"
          inputmode="numeric"
          maxlength="32"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="go"
          autofocus
          class="mt-2 h-14 w-full rounded-key border bg-obsidian px-3 text-center font-mono text-2xl tracking-[0.5em] focus:outline-none"
          :class="pinError ? 'border-neon-coral' : 'border-white/12 focus:border-acid-lime'"
        />
        <p class="mt-2 min-h-5 font-mono text-[11px] tracking-widest text-neon-coral uppercase" role="alert">{{ pinError }}</p>
        <div class="mt-2 mb-1 grid grid-cols-[auto_1fr] gap-2">
          <button
            type="button"
            class="h-12 rounded-key border border-white/12 px-4 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
            @click="pinSheet?.close()"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="h-12 rounded-key bg-acid-lime font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px active:brightness-90 disabled:bg-surface-elevated disabled:text-white/35"
            :disabled="!pinDraft || pinBusy"
          >
            {{ pinBusy ? 'Checking' : 'Unlock' }}
          </button>
        </div>
      </form>
    </dialog>

    <!-- SESSION RESET: the party token was rotated (or is dead); the code from the TV rejoins -->
    <RejoinPanel v-if="store.tokenExpired" />

    <!-- POST-SONG CROWD VOTE -->
    <CrowdVoteSheet v-if="store.activeVote" :key="store.activeVote.songId" :vote="store.activeVote" />

    <!-- TRIVIA BLITZ GAME PAD: only for opted-in players; BROWSE SONGS hides it -->
    <TriviaSheet v-if="store.activeTrivia && store.isJoinedInTrivia && !store.triviaMinimized" />

    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </div>
</template>
