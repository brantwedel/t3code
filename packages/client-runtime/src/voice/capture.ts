// Pure capture-side logic shared by web and native clients; the platform
// layer owns the microphone. VAD constants are measured values carried over
// from the bit-slate voice pipeline — retune by listening, not by eye.
export const VOICE_TARGET_SAMPLE_RATE = 16_000;
export const VOICE_TICK_MS = 500;
export const VOICE_SILENCE_THRESHOLD = 0.01;
export const VOICE_SPEECH_SNR = 3.0;
export const VOICE_ATTACK_MS = 90;
export const VOICE_RELEASE_MS = 200;
export const VOICE_UTTERANCE_END_MS = 900;
export const VOICE_PRE_SPEECH_MS = 450;
export const VOICE_MIN_TICK_MS = 300;
export const VOICE_MAX_BUFFER_MS = 60_000;
/** How long the client keeps trying to reach a server that stopped answering
 *  before it gives up on the utterance. Reconnects and network handovers take
 *  a second or two, and the mic stays open across one, so a wobble costs a
 *  pause rather than the rest of what you were saying. */
export const VOICE_RESUME_WINDOW_MS = 5_000;
const FLOOR_RISE_PER_UPDATE = 1.0005;
const LEVEL_SMOOTH_ALPHA = 0.9;

export interface VoiceVadState {
  readonly speaking: boolean;
  /** False until the first sample seeds the average; see `updateVoiceVad`. */
  readonly primed: boolean;
  readonly smoothedLevel: number;
  readonly noiseFloor: number;
  readonly streakStartedAtMs: number | null;
  readonly lastSpeechAtMs: number | null;
}

export const initialVoiceVadState: VoiceVadState = {
  speaking: false,
  primed: false,
  smoothedLevel: 0,
  noiseFloor: VOICE_SILENCE_THRESHOLD,
  streakStartedAtMs: null,
  lastSpeechAtMs: null,
};

/** Advance the gate one RMS sample; the floor tracks recent ambience so
 *  speech is judged relative to the room, not an absolute level. */
export function updateVoiceVad(state: VoiceVadState, level: number, nowMs: number): VoiceVadState {
  // The first sample seeds the average outright rather than easing up from
  // zero: at 2048-sample frames that ramp costs several hundred milliseconds,
  // and those are exactly the frames holding the first words of someone who
  // starts talking the moment the mic opens.
  const smoothedLevel = state.primed
    ? LEVEL_SMOOTH_ALPHA * state.smoothedLevel + (1 - LEVEL_SMOOTH_ALPHA) * level
    : level;
  const noiseFloor = Math.max(
    VOICE_SILENCE_THRESHOLD,
    Math.min(smoothedLevel, state.noiseFloor * FLOOR_RISE_PER_UPDATE),
  );
  const base = { ...state, primed: true, smoothedLevel, noiseFloor };
  const loud = smoothedLevel > noiseFloor * VOICE_SPEECH_SNR;

  if (!state.speaking) {
    if (!loud) {
      return { ...base, streakStartedAtMs: null };
    }
    const streakStartedAtMs = state.streakStartedAtMs ?? nowMs;
    if (nowMs - streakStartedAtMs >= VOICE_ATTACK_MS) {
      return { ...base, speaking: true, streakStartedAtMs: null, lastSpeechAtMs: nowMs };
    }
    return { ...base, streakStartedAtMs };
  }

  if (loud) {
    return { ...base, streakStartedAtMs: null, lastSpeechAtMs: nowMs };
  }
  const streakStartedAtMs = state.streakStartedAtMs ?? nowMs;
  if (nowMs - streakStartedAtMs >= VOICE_RELEASE_MS) {
    return { ...base, speaking: false, streakStartedAtMs: null };
  }
  return { ...base, streakStartedAtMs };
}

/** True once silence has lasted long enough to finalize the utterance. */
export function voiceUtteranceEnded(state: VoiceVadState, nowMs: number): boolean {
  return (
    !state.speaking &&
    state.lastSpeechAtMs !== null &&
    nowMs - state.lastSpeechAtMs >= VOICE_UTTERANCE_END_MS
  );
}

/**
 * Bounded mono PCM ring with an absolute sample axis, so a consumer can read
 * "everything after sample N" regardless of how much old audio was dropped.
 */
export class VoicePcmRing {
  readonly sampleRate: number;
  private readonly maxSamples: number;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private droppedSamples = 0;

  constructor(sampleRate: number, maxSamples?: number) {
    this.sampleRate = sampleRate;
    this.maxSamples = maxSamples ?? Math.floor((VOICE_MAX_BUFFER_MS / 1000) * sampleRate);
  }

  get absoluteSampleCount(): number {
    return this.totalSamples;
  }

  get bufferedSampleCount(): number {
    return this.totalSamples - this.droppedSamples;
  }

  push(frame: Float32Array): void {
    this.chunks.push(frame);
    this.totalSamples += frame.length;
    while (this.totalSamples - this.droppedSamples > this.maxSamples && this.chunks.length > 0) {
      const oldest = this.chunks[0]!;
      this.chunks.shift();
      this.droppedSamples += oldest.length;
    }
  }

  /** Read from an absolute sample position to the live edge. */
  readFromAbsolute(startSample: number): Float32Array {
    const start = Math.max(startSample, this.droppedSamples);
    if (start >= this.totalSamples) return new Float32Array(0);
    const out = new Float32Array(this.totalSamples - start);
    let chunkStart = this.droppedSamples;
    let written = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunkStart + chunk.length;
      if (chunkEnd > start) {
        const from = Math.max(0, start - chunkStart);
        out.set(chunk.subarray(from), written);
        written += chunk.length - from;
      }
      chunkStart = chunkEnd;
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.droppedSamples = this.totalSamples;
  }
}

export function resampleLinear(
  source: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || source.length === 0) return source;
  const outLength = Math.floor((source.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const lastIndex = source.length - 1;
  for (let index = 0; index < outLength; index += 1) {
    const position = (index * fromRate) / toRate;
    const base = Math.min(Math.floor(position), lastIndex);
    const next = Math.min(base + 1, lastIndex);
    const fraction = position - base;
    out[index] = source[base]! + (source[next]! - source[base]!) * fraction;
  }
  return out;
}

/** Encode float samples as the wire format: base64 of int16 LE mono PCM. */
export function encodeVoicePcm(samples: Float32Array): { base64: string; byteLength: number } {
  const ints = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    ints[index] = Math.round(clamped * 32_767);
  }
  const bytes = new Uint8Array(ints.buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return { base64: btoa(binary), byteLength: bytes.byteLength };
}

/** Root-mean-square level of one capture frame, for the VAD and level meter. */
export function frameRmsLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) {
    sum += frame[index]! * frame[index]!;
  }
  return Math.sqrt(sum / frame.length);
}
