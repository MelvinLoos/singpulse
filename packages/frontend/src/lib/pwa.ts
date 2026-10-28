import { onMounted, onUnmounted, ref } from 'vue';

const DISMISSED_KEY = 'singpulse_install_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false; // Private mode: show the card again next visit
  }
}

function matchesStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

// Module-level so the event is captured even if it fires before the lazy remote chunk loads
const installEvent = ref<BeforeInstallPromptEvent | null>(null);
const installed = ref(false);
const dismissed = ref(readDismissed());
export const isStandalone = matchesStandalone();

const ua = navigator.userAgent;
const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
export const isIosSafari = isIos && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installEvent.value = event as BeforeInstallPromptEvent;
});
window.addEventListener('appinstalled', () => {
  installed.value = true;
  installEvent.value = null;
});

export const canInstall = (): boolean => installEvent.value !== null;
export { installEvent, installed, dismissed };

export async function promptInstall(): Promise<void> {
  const event = installEvent.value;
  if (!event) return;
  installEvent.value = null; // The event is single-use
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') installed.value = true;
}

export function dismissInstallCard(): void {
  dismissed.value = true;
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // In-memory dismissal still holds for this visit
  }
}

function pageIsIdle(): boolean {
  if (document.visibilityState === 'hidden') return true;
  const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
  return !typing && !document.querySelector('dialog[open]');
}

/**
 * Registers the service worker for the remote only. New builds activate on their own
 * (skipWaiting + clientsClaim); the reload that follows waits until nobody is mid-input.
 */
export function usePwaUpdates(): void {
  if (!window.location.pathname.startsWith('/remote')) return;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;

  let registration: ServiceWorkerRegistration | undefined;
  let reloadWhenIdle = false;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function tryReload(): void {
    if (!reloadWhenIdle || !pageIsIdle()) return;
    window.location.reload();
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible') void registration?.update().catch(() => undefined);
    tryReload();
  }

  onMounted(async () => {
    const { registerSW } = await import('virtual:pwa-register');
    // The first controllerchange is the worker taking over a fresh install: not an update
    const hadController = navigator.serviceWorker.controller !== null;
    registerSW({
      immediate: true,
      onRegisteredSW: (_url, reg) => (registration = reg)
    });
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        reloadWhenIdle = true;
        tryReload();
      });
    }
    idleTimer = setInterval(tryReload, 5000);
    document.addEventListener('visibilitychange', onVisibility);
  });

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    if (idleTimer) clearInterval(idleTimer);
  });
}
