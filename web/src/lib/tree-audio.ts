/**
 * ADQS Exam v2 — Procedural Web Audio engine for the Tree of Knowledge (Phase 8.3)
 * =====================================================================
 * TypeScript port of `v2/student/tree-audio.js`. The two live on opposite sides
 * of the bundler boundary — the student SPA loads a plain ES module over HTTP
 * while the teacher app is compiled by Next.js — so they are kept as parallel
 * copies rather than a shared import. Their public surface is identical; the
 * e2e suite (Step 34) asserts the student module's exports and exercises both
 * through a mock `AudioContext`.
 *
 * Zero dependencies: every sound is a short graph of sine oscillators with
 * exponential gain envelopes, so the bundle stays tiny and the timbre can be
 * modulated by the live tree state (vitality).
 *
 * AUTOPLAY POLICY
 *   Browsers start an `AudioContext` in the `suspended` state until a user
 *   gesture resumes it. `resumeAudioContext()` must therefore be called from
 *   inside a click/tap handler; the play helpers otherwise no-op, so a call from
 *   a background Realtime event can never throw or log a console warning.
 *
 * MUTE PERSISTENCE
 *   The mute flag is mirrored into `localStorage` under `adqs_tree_muted` so the
 *   projector keeps the teacher's choice across reloads.
 */

/** Lazy singleton; created on first use so no AudioContext exists before a gesture. */
let audioCtx: AudioContext | null = null;
let isMuted = false;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

// Read the initial mute state from localStorage. Guarded because the key is read
// at module scope, where `localStorage` may not exist (SSR, or a locked-down
// browser context such as a sandboxed iframe).
try {
  isMuted = localStorage.getItem('adqs_tree_muted') === 'true';
} catch {
  isMuted = false;
}

/** Returns the shared AudioContext, creating it on first call. */
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass =
      window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  return audioCtx;
}

/** Whether sound is currently muted. */
export function isAudioMuted(): boolean {
  return isMuted;
}

/** Sets the mute flag and persists it. Returns the applied value. */
export function setAudioMuted(muted: boolean): boolean {
  isMuted = !!muted;
  try {
    localStorage.setItem('adqs_tree_muted', String(isMuted));
  } catch {
    // Persistence is best-effort; a failed write must not break playback.
  }
  return isMuted;
}

/** Flips the mute flag. Returns the new value. */
export function toggleAudioMute(): boolean {
  return setAudioMuted(!isMuted);
}

/**
 * Resumes a suspended AudioContext. MUST be awaited from a user-gesture handler
 * (click/tap) to satisfy the browser Autoplay Policy. Returns the context, or
 * null when Web Audio is unavailable.
 */
export async function resumeAudioContext(): Promise<AudioContext | null> {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // A rejected resume (e.g. no gesture yet) is not an error worth surfacing.
    }
  }
  return ctx;
}

/**
 * Plays a delicate organic water-drop sound ("Tách… tưng").
 *
 * The pitch is a quick upward chirp (a droplet hitting a surface) followed by a
 * slightly lower resonant body. A more vital tree (V -> 1) yields a brighter
 * droplet, so a lively class literally sounds different from a sluggish one.
 *
 * @param vitality - Tree vitality in [0.2, 1.0]; 1.0 is brightest.
 */
export function playDewdropSound(vitality = 1.0): void {
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  // Modulate the base pitch by vitality: a vibrant tree = a slightly brighter drop.
  const baseFreq = 750 + Math.max(0.2, Math.min(1.0, vitality)) * 250; // 800Hz - 1000Hz

  osc.type = 'sine';
  // Water-drop frequency chirp: a quick rising tone then a resonant body.
  osc.frequency.setValueAtTime(baseFreq * 0.85, now);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.8, now + 0.035);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.1, now + 0.12);

  // Snappy attack, smooth organic decay. Both targets are > 0 because
  // exponentialRampToValueAtTime cannot reach 0.
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.28, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.24);
}

/**
 * Plays the celestial wind-chime arpeggio for the 100% bloom celebration
 * (P = 1.0). Six pentatonic notes (C5 → E6) staggered 120ms apart, each with a
 * warm bell envelope that rings for ~1.2s so the arpeggio blends into a chord.
 */
export function playBloomFanfare(): void {
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  // Pentatonic celebration notes: C5, E5, G5, B5, C6, E6.
  const frequencies = [523.25, 659.25, 783.99, 987.77, 1046.5, 1318.51];

  frequencies.forEach((freq, index) => {
    const noteTime = now + index * 0.12; // 120ms staggered arpeggio
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, noteTime);

    // Warm chime bell envelope.
    gain.gain.setValueAtTime(0.001, noteTime);
    gain.gain.exponentialRampToValueAtTime(0.22, noteTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 1.2);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(noteTime);
    osc.stop(noteTime + 1.25);
  });
}
