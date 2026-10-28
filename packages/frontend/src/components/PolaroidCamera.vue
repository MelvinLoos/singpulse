<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { Camera, ImageUp, RefreshCw, RotateCcw, Send, Trash2, X } from 'lucide-vue-next';
import { PolaroidCooldownError, useKaraokeStore } from '../stores/karaoke.ts';
import { useSingerName } from '../lib/singerName.ts';
import { useSheetDrag } from '../lib/sheetDrag.ts';

const COOLDOWN_S = 15;
const MAX_CAPTION = 24;
const ICON_STROKE = 1.75;

const emit = defineEmits<{ announce: [message: string] }>();

const store = useKaraokeStore();
const { singerName } = useSingerName();

type Step = 'live' | 'review';

const cameraDialog = ref<HTMLDialogElement | null>(null);
const wallDialog = ref<HTMLDialogElement | null>(null);
const wallDrag = useSheetDrag(wallDialog);
const videoEl = ref<HTMLVideoElement | null>(null);
const fallbackInput = ref<HTMLInputElement | null>(null);

const step = ref<Step>('live');
const facing = ref<'environment' | 'user'>('environment');
const cameraReady = ref(false);
const cameraError = ref('');
const canFlip = ref(false);
const flash = ref(false);

const file = ref<File | null>(null);
const previewUrl = ref('');
const caption = ref('');
const busy = ref(false);
const error = ref('');
const cooldown = ref(0);
let stream: MediaStream | null = null;
let cooldownTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const canSend = computed(() => file.value !== null && !busy.value && cooldown.value === 0);
const hasLiveCamera = computed(() => typeof navigator.mediaDevices?.getUserMedia === 'function');

/* ------------------------------------------------------------------ stream */
function stopStream(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  cameraReady.value = false;
  if (videoEl.value) videoEl.value.srcObject = null;
}

async function startStream(): Promise<void> {
  stopStream();
  cameraError.value = '';
  if (!hasLiveCamera.value) {
    cameraError.value = 'CAMERA UNAVAILABLE';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing.value }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    if (!cameraDialog.value?.open || step.value !== 'live') {
      stopStream(); // Closed while the permission prompt was up
      return;
    }
    await nextTick();
    const video = videoEl.value;
    if (!video) return;
    video.srcObject = stream;
    await video.play();
    cameraReady.value = true;
    const devices = await navigator.mediaDevices.enumerateDevices();
    canFlip.value = devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch (err) {
    stopStream();
    const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    cameraError.value = denied ? 'CAMERA BLOCKED' : 'NO CAMERA';
  }
}

/* ----------------------------------------------------------------- dialogs */
function openCamera(): void {
  resetShot();
  step.value = 'live';
  cameraDialog.value?.showModal();
  void startStream();
}

function onCameraClose(): void {
  stopStream();
  resetShot();
}

function resetShot(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  file.value = null;
  caption.value = '';
  error.value = '';
}

function openWall(): void {
  wallDialog.value?.showModal();
}

function flipCamera(): void {
  facing.value = facing.value === 'environment' ? 'user' : 'environment';
  void startStream();
}

/* ----------------------------------------------------------------- capture */
function showReview(shot: File): void {
  resetShot();
  file.value = shot;
  previewUrl.value = URL.createObjectURL(shot);
  step.value = 'review';
  stopStream(); // Save battery while the guest writes a caption
}

function snap(): void {
  const video = videoEl.value;
  if (!video || !cameraReady.value || !video.videoWidth) return;
  // Centre square crop: matches the instant-film frame on the TV
  const side = Math.min(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(side, 1080);
  canvas.getContext('2d')?.drawImage(
    video,
    (video.videoWidth - side) / 2,
    (video.videoHeight - side) / 2,
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height
  );
  navigator.vibrate?.(30);
  flash.value = true;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.value = false), 180);
  canvas.toBlob(
    (blob) => {
      if (blob) showReview(new File([blob], 'polaroid.jpg', { type: 'image/jpeg' }));
      else cameraError.value = 'CAPTURE FAILED';
    },
    'image/jpeg',
    0.9
  );
}

function onFallbackPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const picked = input.files?.[0];
  input.value = '';
  if (!picked) return;
  if (!cameraDialog.value?.open) cameraDialog.value?.showModal();
  showReview(picked);
}

function retake(): void {
  resetShot();
  step.value = 'live';
  void startStream();
}

/* -------------------------------------------------------------------- send */
function startCooldown(seconds: number): void {
  cooldown.value = seconds;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldown.value = Math.max(0, cooldown.value - 1);
    if (cooldown.value === 0 && cooldownTimer) clearInterval(cooldownTimer);
  }, 1000);
}

async function send(): Promise<void> {
  if (!file.value || !canSend.value) return;
  busy.value = true;
  error.value = '';
  try {
    await store.sendPolaroid(file.value, caption.value, singerName.value || undefined);
    navigator.vibrate?.(10);
    emit('announce', 'Photo sent');
    startCooldown(COOLDOWN_S);
    cameraDialog.value?.close();
  } catch (err) {
    if (err instanceof PolaroidCooldownError) {
      startCooldown(err.retryAfterSeconds);
      error.value = 'TOO SOON — WAIT';
    } else {
      error.value = 'SEND FAILED';
    }
  } finally {
    busy.value = false;
  }
}

/* -------------------------------------------------------------- host: wall */
const deletingId = ref<string | null>(null);
const wallError = ref('');

async function removePhoto(id: string): Promise<void> {
  deletingId.value = id;
  wallError.value = '';
  try {
    await store.deletePolaroid(id);
    emit('announce', 'Photo removed from the wall');
  } catch {
    wallError.value = 'DELETE FAILED';
  } finally {
    deletingId.value = null;
  }
}

onUnmounted(() => {
  stopStream();
  resetShot();
  if (cooldownTimer) clearInterval(cooldownTimer);
  if (flashTimer) clearTimeout(flashTimer);
});

defineExpose({ openWall });
</script>

<template>
  <button
    type="button"
    class="grid size-11 place-items-center rounded-key text-white/80 active:translate-y-px active:bg-surface-elevated"
    aria-label="Open camera for the TV photo wall"
    aria-haspopup="dialog"
    @click="openCamera"
  >
    <Camera class="size-5" :stroke-width="ICON_STROKE" aria-hidden="true" />
  </button>
  <!-- Fallback when a live camera is unavailable: opens the phone's own camera app -->
  <input ref="fallbackInput" type="file" accept="image/*" capture="environment" class="hidden" @change="onFallbackPicked" />

  <!-- FULL-SCREEN CAMERA -->
  <dialog
    ref="cameraDialog"
    aria-labelledby="camera-title"
    class="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-obsidian p-0 text-white"
    @close="onCameraClose"
  >
    <div class="flex h-full flex-col px-safe pt-safe pb-safe">
      <header class="flex items-center justify-between gap-3">
        <h2 id="camera-title" class="font-mono text-[11px] tracking-widest text-acid-lime uppercase">
          {{ step === 'live' ? 'Photo' : 'Caption' }}
        </h2>
        <button
          type="button"
          class="grid size-11 place-items-center rounded-key border border-white/12 active:translate-y-px active:bg-surface-elevated"
          aria-label="Close camera"
          @click="cameraDialog?.close()"
        >
          <X class="size-5" :stroke-width="ICON_STROKE" />
        </button>
      </header>

      <!-- LIVE VIEWFINDER -->
      <template v-if="step === 'live'">
        <div class="relative mx-auto mt-3 aspect-square w-full max-w-[min(100%,60dvh)] overflow-hidden rounded-module border border-white/12 bg-surface">
          <video
            ref="videoEl"
            class="size-full object-cover"
            :class="facing === 'user' ? '-scale-x-100' : ''"
            autoplay
            muted
            playsinline
            aria-label="Camera preview"
          />
          <!-- Corner brackets: the square is what the TV prints -->
          <div v-if="cameraReady" class="pointer-events-none absolute inset-3" aria-hidden="true">
            <span class="absolute top-0 left-0 size-6 border-t-2 border-l-2 border-acid-lime" />
            <span class="absolute top-0 right-0 size-6 border-t-2 border-r-2 border-acid-lime" />
            <span class="absolute bottom-0 left-0 size-6 border-b-2 border-l-2 border-acid-lime" />
            <span class="absolute right-0 bottom-0 size-6 border-r-2 border-b-2 border-acid-lime" />
          </div>
          <div v-if="flash" class="pointer-events-none absolute inset-0 bg-white" aria-hidden="true" />

          <div v-if="!cameraReady" class="absolute inset-0 grid place-items-center p-6 text-center">
            <p v-if="!cameraError" class="font-mono text-[11px] tracking-widest text-white/70 uppercase motion-safe:animate-shimmer" role="status">
              Starting camera
            </p>
            <div v-else>
              <Camera class="mx-auto size-10 text-neon-coral" :stroke-width="1.5" aria-hidden="true" />
              <p class="mt-3 font-mono text-[11px] leading-relaxed tracking-widest text-neon-coral uppercase" role="alert">{{ cameraError }}</p>
              <button
                type="button"
                class="mt-4 inline-flex h-12 items-center gap-2 rounded-key bg-acid-lime px-5 font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px active:brightness-90"
                @click="fallbackInput?.click()"
              >
                <ImageUp class="size-4" :stroke-width="2" aria-hidden="true" />
                Use photo app
              </button>
              <button
                v-if="hasLiveCamera"
                type="button"
                class="mt-2 block w-full font-mono text-[11px] tracking-widest text-white/70 uppercase underline-offset-4 active:underline"
                @click="startStream"
              >
                Try again
              </button>
            </div>
          </div>
        </div>

        <p class="mt-3 text-center font-mono text-[11px] tracking-widest text-white/70 uppercase" role="status">
          {{ cooldown ? `Next photo in ${cooldown}s` : '' }}
        </p>

        <!-- Shutter deck sits in the thumb zone -->
        <div class="mt-auto grid grid-cols-3 items-center pt-4">
          <button
            type="button"
            class="grid size-12 place-items-center justify-self-start rounded-key border border-white/12 bg-surface-elevated active:translate-y-px disabled:opacity-35"
            aria-label="Choose from photo app"
            @click="fallbackInput?.click()"
          >
            <ImageUp class="size-5" :stroke-width="ICON_STROKE" />
          </button>
          <button
            type="button"
            class="grid size-20 place-items-center justify-self-center rounded-full border-4 border-white p-1 active:scale-95 disabled:opacity-35"
            aria-label="Take photo"
            :disabled="!cameraReady"
            @click="snap"
          >
            <span class="block size-full rounded-full bg-acid-lime" />
          </button>
          <button
            v-if="canFlip"
            type="button"
            class="grid size-12 place-items-center justify-self-end rounded-key border border-white/12 bg-surface-elevated active:translate-y-px"
            :aria-label="facing === 'environment' ? 'Switch to selfie camera' : 'Switch to back camera'"
            @click="flipCamera"
          >
            <RefreshCw class="size-5" :stroke-width="ICON_STROKE" />
          </button>
          <span v-else />
        </div>
      </template>

      <!-- REVIEW: type the stamp straight onto the print -->
      <template v-else>
        <div class="mx-auto mt-3 w-full max-w-[min(100%,52dvh)] bg-film-paper p-3 pb-4 text-obsidian">
          <img :src="previewUrl" alt="Your photo" class="aspect-square w-full bg-obsidian object-cover" />
          <label for="polaroid-caption" class="mt-3 block font-mono text-[10px] tracking-widest uppercase">
            Caption (optional)
          </label>
          <input
            id="polaroid-caption"
            v-model="caption"
            :maxlength="MAX_CAPTION"
            class="mt-1 h-11 w-full border-b-2 border-obsidian bg-transparent font-mono text-base font-bold tracking-widest uppercase placeholder:text-obsidian/40 focus:outline-none"
            placeholder="ENCORE!!"
            autocomplete="off"
            autocapitalize="characters"
            enterkeyhint="send"
            @keydown.enter.prevent="send"
          />
        </div>

        <p v-if="error" class="mt-3 text-center font-mono text-[11px] tracking-widest text-neon-coral uppercase" role="alert">{{ error }}</p>

        <div class="mt-auto grid grid-cols-[auto_1fr] gap-2 pt-4">
          <button
            type="button"
            class="flex h-14 items-center gap-2 rounded-key border border-white/12 bg-surface-elevated px-4 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px disabled:opacity-35"
            :disabled="busy"
            @click="retake"
          >
            <RotateCcw class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" />
            Retake
          </button>
          <button
            type="button"
            class="flex h-14 items-center justify-center gap-2 rounded-key bg-acid-lime font-mono text-[11px] font-bold tracking-widest text-obsidian uppercase active:translate-y-px active:brightness-90 disabled:bg-surface-elevated disabled:text-white/35"
            :disabled="!canSend"
            @click="send"
          >
            <Send class="size-4" :stroke-width="2" aria-hidden="true" />
            {{ busy ? 'Sending' : cooldown ? `Wait ${cooldown}s` : 'Send to TV' }}
          </button>
        </div>
      </template>
    </div>
  </dialog>

  <!-- HOST: saved prints -->
  <dialog
    ref="wallDialog"
    closedby="any"
    aria-labelledby="wall-title"
    class="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none translate-y-0 overflow-y-auto short:max-h-[92dvh] rounded-t-[6px] border-t border-white/12 bg-surface p-0 text-white transition-transform duration-300 ease-out motion-reduce:transition-none starting:open:translate-y-full"
  >
    <div class="px-safe pt-2 pb-safe">
      <div class="-mt-2 flex h-6 touch-none items-center" v-bind="wallDrag.dragHandlers" aria-hidden="true">
        <div class="mx-auto h-1 w-10 rounded-full bg-white/25" />
      </div>
      <div class="mt-1 flex items-center justify-between gap-3">
        <div>
          <h2 id="wall-title" class="font-display text-2xl leading-none font-extrabold tracking-tighter uppercase">Photo wall</h2>
          <p class="mt-1 font-mono text-[11px] tracking-widest text-white/70 uppercase">
            {{ String(store.polaroids.length).padStart(2, '0') }} photos
          </p>
        </div>
        <button
          type="button"
          class="grid size-11 place-items-center rounded-key border border-white/12 active:translate-y-px active:bg-surface-elevated"
          aria-label="Close photo wall"
          @click="wallDialog?.close()"
        >
          <X class="size-5" :stroke-width="ICON_STROKE" />
        </button>
      </div>
      <p v-if="wallError" class="mt-3 font-mono text-[11px] tracking-widest text-neon-coral uppercase" role="alert">{{ wallError }}</p>
      <p v-if="!store.polaroids.length" class="mt-4 font-mono text-[11px] tracking-widest text-white/70 uppercase">No photos</p>
      <ul class="mt-3 grid grid-cols-3 gap-2">
        <li v-for="item in [...store.polaroids].reverse()" :key="item.id" class="relative">
          <img :src="item.imageUrl" :alt="`Photo by ${item.sender}`" class="aspect-square w-full rounded-module object-cover" loading="lazy" />
          <button
            type="button"
            class="absolute right-0 bottom-0 grid size-11 place-items-center rounded-tl-key bg-obsidian/85 text-neon-coral active:translate-y-px disabled:opacity-40"
            :aria-label="`Delete photo by ${item.sender}`"
            :disabled="deletingId === item.id"
            @click="removePhoto(item.id)"
          >
            <Trash2 class="size-4" :stroke-width="ICON_STROKE" />
          </button>
        </li>
      </ul>
    </div>
  </dialog>
</template>
