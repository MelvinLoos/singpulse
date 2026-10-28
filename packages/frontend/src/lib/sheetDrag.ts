import { onUnmounted, type Ref } from 'vue';

const CLOSE_RATIO = 0.25;
const FLICK_PX_PER_MS = 0.6;

/**
 * Swipe-down-to-dismiss for a bottom-sheet <dialog>. Attach the returned handlers to the
 * grab handle / header; the sheet follows the finger and closes past 25% or on a flick.
 */
export function useSheetDrag(dialog: Ref<HTMLDialogElement | null>) {
  let pointerId = -1;
  let startY = 0;
  let startAt = 0;
  let dy = 0;

  function reset(): void {
    const el = dialog.value;
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
  }

  function onPointerDown(event: PointerEvent): void {
    const el = dialog.value;
    if (!el || pointerId !== -1 || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startAt = event.timeStamp;
    dy = 0;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    el.style.transition = 'none';
  }

  function onPointerMove(event: PointerEvent): void {
    const el = dialog.value;
    if (!el || event.pointerId !== pointerId) return;
    dy = Math.max(0, event.clientY - startY); // Only downward
    el.style.transform = `translateY(${dy}px)`;
  }

  function onPointerEnd(event: PointerEvent): void {
    const el = dialog.value;
    if (!el || event.pointerId !== pointerId) return;
    pointerId = -1;
    const elapsed = Math.max(1, event.timeStamp - startAt);
    const shouldClose =
      event.type === 'pointerup' && (dy > el.offsetHeight * CLOSE_RATIO || (dy > 24 && dy / elapsed > FLICK_PX_PER_MS));
    el.style.transition = '';
    if (shouldClose) {
      el.close();
      requestAnimationFrame(reset);
    } else {
      reset();
    }
  }

  onUnmounted(reset);

  return {
    dragHandlers: {
      onPointerdown: onPointerDown,
      onPointermove: onPointerMove,
      onPointerup: onPointerEnd,
      onPointercancel: onPointerEnd
    }
  };
}
