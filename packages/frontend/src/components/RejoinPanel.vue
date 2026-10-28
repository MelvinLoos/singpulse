<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { ScanLine, ScanQrCode, X } from 'lucide-vue-next';
import { useKaraokeStore } from '../stores/karaoke.ts';

const ICON_STROKE = 1.75;
const SCAN_INTERVAL_MS = 250;

interface QrDetector {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
}
type QrDetectorCtor = {
  new (options: { formats: string[] }): QrDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

const store = useKaraokeStore();
const code = ref('');
const busy = ref(false);
const scanning = ref(false);
const scanError = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);
const canScan = ref(false);

let stream: MediaStream | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;

// iOS WebKit has no BarcodeDetector: there the code field is the whole flow
const Detector = (window as unknown as { BarcodeDetector?: QrDetectorCtor }).BarcodeDetector;
if (Detector && typeof navigator.mediaDevices?.getUserMedia === 'function') {
  void (Detector.getSupportedFormats?.() ?? Promise.resolve(['qr_code'])).then((formats) => {
    canScan.value = formats.includes('qr_code');
  });
}

const failed = computed(() => store.rejoinFailed);

function submit(): void {
  if (!code.value.trim() || busy.value) return;
  busy.value = true;
  store.rejoin(code.value);
  // The socket answers within a second or two; re-arm the key either way
  setTimeout(() => (busy.value = false), 2500);
}

function stopScan(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  scanning.value = false;
}

async function startScan(): Promise<void> {
  if (!Detector || scanning.value) return;
  scanError.value = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    scanning.value = true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const video = videoEl.value;
    if (!video) return stopScan();
    video.srcObject = stream;
    await video.play();
    const detector = new Detector({ formats: ['qr_code'] });
    scanTimer = setInterval(async () => {
      try {
        const [hit] = await detector.detect(video);
        if (!hit) return;
        stopScan();
        code.value = hit.rawValue;
        submit();
      } catch {
        // A frame that cannot be decoded is normal; keep scanning
      }
    }, SCAN_INTERVAL_MS);
  } catch {
    stopScan();
    scanError.value = 'Camera blocked — type the code instead';
  }
}

onUnmounted(stopScan);
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-obsidian px-safe pt-safe pb-safe"
    role="alertdialog"
    aria-labelledby="reset-title"
  >
    <div class="flex flex-1 flex-col justify-center py-6">
      <ScanLine class="size-9 text-neon-coral short:hidden" :stroke-width="1.5" aria-hidden="true" />
      <p class="mt-4 font-mono text-[11px] tracking-widest text-neon-coral uppercase short:mt-0">Link closed // Code rotated</p>
      <h2 id="reset-title" class="mt-2 font-display text-4xl leading-[0.9] font-extrabold tracking-tighter uppercase short:text-3xl">
        Session <span class="text-acid-lime">reset</span>
      </h2>

      <form class="mt-6" @submit.prevent="submit">
        <label for="rejoin-code" class="block font-mono text-[11px] tracking-widest text-white/70 uppercase">
          Type the code shown on the TV
        </label>
        <input
          id="rejoin-code"
          v-model="code"
          inputmode="text"
          enterkeyhint="go"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="TOKEN"
          class="mt-2 h-16 w-full rounded-key border bg-surface px-3 text-center font-mono text-2xl tracking-[0.3em] placeholder:text-white/30 focus:outline-none"
          :class="failed ? 'border-neon-coral' : 'border-white/12 focus:border-acid-lime'"
        />
        <p class="mt-2 min-h-5 font-mono text-[11px] tracking-widest text-neon-coral uppercase" role="alert">
          {{ failed ? 'Code rejected // check the TV' : scanError }}
        </p>
        <button
          type="submit"
          class="mt-2 h-14 w-full rounded-key bg-acid-lime font-mono text-xs font-bold tracking-widest text-obsidian uppercase active:translate-y-px active:brightness-90 disabled:bg-surface-elevated disabled:text-white/35"
          :disabled="!code.trim() || busy"
        >
          {{ busy ? 'Linking' : 'Rejoin' }}
        </button>
      </form>

      <template v-if="canScan">
        <button
          v-if="!scanning"
          type="button"
          class="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-key border border-white/25 font-mono text-[11px] font-bold tracking-widest uppercase active:translate-y-px active:bg-surface-elevated"
          @click="startScan"
        >
          <ScanQrCode class="size-4" :stroke-width="ICON_STROKE" aria-hidden="true" /> Scan TV QR
        </button>
        <div v-else class="relative mt-3 aspect-square w-full max-w-[min(100%,40dvh)] self-center overflow-hidden rounded-module border border-acid-lime/60 bg-surface">
          <video ref="videoEl" class="size-full object-cover" playsinline muted />
          <button
            type="button"
            class="absolute top-1 right-1 grid size-11 place-items-center rounded-key bg-obsidian/70 text-white"
            aria-label="Stop scanning"
            @click="stopScan"
          >
            <X class="size-5" :stroke-width="ICON_STROKE" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
