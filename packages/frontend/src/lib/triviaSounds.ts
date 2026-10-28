// Tiny Web Audio synth for the TV trivia stage: short, soft, no samples to ship.
// The context is created lazily so nothing runs unless a game is on screen.

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

interface Note {
  freq: number;
  at?: number;      // seconds from now
  length?: number;  // seconds
  type?: OscillatorType;
  gain?: number;
}

function play(notes: Note[]): void {
  const audio = context();
  if (!audio) return;
  for (const { freq, at = 0, length = 0.12, type = 'triangle', gain = 0.06 } of notes) {
    const start = audio.currentTime + at;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    // Fast attack, exponential release: avoids clicks
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(amp).connect(audio.destination);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }
}

// C major: C5 E5 G5 C6
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

export const triviaSounds = {
  blip: () => play([{ freq: 880, length: 0.09 }, { freq: 1320, at: 0.06, length: 0.1 }]),
  tick: () => play([{ freq: 1500, length: 0.05, type: 'square', gain: 0.03 }]),
  chime: () => play([C5, E5, G5].map((freq) => ({ freq, length: 0.9, type: 'sine' as const, gain: 0.05 }))),
  fanfare: () =>
    play([
      { freq: C5, at: 0, length: 0.18, type: 'sawtooth', gain: 0.04 },
      { freq: E5, at: 0.16, length: 0.18, type: 'sawtooth', gain: 0.04 },
      { freq: G5, at: 0.32, length: 0.18, type: 'sawtooth', gain: 0.04 },
      { freq: C6, at: 0.48, length: 1.1, type: 'sawtooth', gain: 0.05 },
      { freq: G5, at: 0.48, length: 1.1, type: 'sine', gain: 0.04 }
    ]),
  dispose: () => {
    const audio = ctx;
    ctx = null;
    void audio?.close().catch(() => {});
  }
};
