import type { VoiceSessionId, VoiceTranscript } from "@t3tools/contracts";

import {
  VOICE_MIN_TICK_MS,
  VOICE_PRE_SPEECH_MS,
  VOICE_RESUME_WINDOW_MS,
  VOICE_TARGET_SAMPLE_RATE,
  VOICE_TICK_MS,
  VoicePcmRing,
  encodeVoicePcm,
  resampleLinear,
} from "./capture.ts";

/** Cap one cut well under the wire's chunk bound so a long outage drains as
 *  several appends instead of one oversized, forever-rejected chunk. */
const MAX_CHUNK_SOURCE_SECONDS = 10;
/** After a final is requested, give a flaky transport this many attempts. */
const MAX_FINAL_ATTEMPTS = 3;
/** A retried append costs a tick, so the resume window converts to attempts.
 *  Past it the server is not coming back inside this utterance; ending it
 *  frees the caller to start a fresh session rather than holding the mic open
 *  against a cursor the server has long since forgotten. */
const MAX_APPEND_ATTEMPTS = Math.max(
  MAX_FINAL_ATTEMPTS,
  Math.ceil(VOICE_RESUME_WINDOW_MS / VOICE_TICK_MS),
);
/** Cut an utterance here even if the gate never closes; a cumulative
 *  transcript would otherwise grow without bound. Matches whisper's window. */
const MAX_UTTERANCE_SECONDS = 30;

/** Transport the driver speaks through: the voice.session* RPCs on web,
 *  stubs in tests. */
export interface VoiceSessionTransport {
  readonly start: (input: {
    readonly sampleRate: number;
    readonly language?: string | undefined;
  }) => Promise<{ readonly sessionId: VoiceSessionId }>;
  readonly append: (input: {
    readonly sessionId: VoiceSessionId;
    readonly pcm: string;
    readonly offsetBytes: number;
    readonly final: boolean;
  }) => Promise<VoiceTranscript>;
  readonly close: (sessionId: VoiceSessionId) => Promise<void>;
}

export interface VoiceTickScheduler {
  readonly schedule: (run: () => void, delayMs: number) => () => void;
}

export interface VoiceSessionDriverOptions {
  readonly transport: VoiceSessionTransport;
  readonly scheduler: VoiceTickScheduler;
  readonly sourceSampleRate: number;
  readonly language?: string | undefined;
  /** Each reply replaces the whole dictated span — never append. */
  readonly onTranscript: (transcript: VoiceTranscript) => void;
  readonly onError: (error: unknown) => void;
  /** Errors no retry can cure; the driver closes best-effort and reports once. */
  readonly isTerminalError?: (error: unknown) => boolean;
}

interface DriverState {
  sessionId: VoiceSessionId | null;
  sentSourceSamples: number;
  sentBytes: number;
  pendingChunk: { readonly base64: string; readonly byteLength: number } | null;
  ticking: boolean;
  /** True once the gate has heard speech; no speech, no transcribe call. */
  utterancePending: boolean;
  /** Ring position at that first speech, so the length cap measures speech and
   *  not however long the mic sat open waiting for it. */
  utteranceStartSamples: number | null;
  finalRequested: boolean;
  /** Ring position frozen at requestFinal; later frames belong to no utterance. */
  finalCutSamples: number | null;
  failedAttempts: number;
  done: boolean;
}

/**
 * Drives one dictation utterance on a non-overlapping tick. A failed append
 * leaves the byte cursor put and retries the identical chunk, which the server
 * dedups, so words are never lost or doubled. `final` rides only the last
 * chunk, after any retried backlog has drained.
 */
export class VoiceSessionDriver {
  private readonly options: VoiceSessionDriverOptions;
  private readonly ring: VoicePcmRing;
  private readonly state: DriverState = {
    sessionId: null,
    sentSourceSamples: 0,
    sentBytes: 0,
    pendingChunk: null,
    ticking: false,
    utterancePending: false,
    utteranceStartSamples: null,
    finalRequested: false,
    finalCutSamples: null,
    failedAttempts: 0,
    done: false,
  };
  private cancelTick: (() => void) | null = null;

  constructor(options: VoiceSessionDriverOptions) {
    this.options = options;
    this.ring = new VoicePcmRing(options.sourceSampleRate);
  }

  get isDone(): boolean {
    return this.state.done;
  }

  pushAudio(frame: Float32Array): void {
    if (this.state.done) return;
    this.ring.push(frame);
  }

  /** The gate heard speech. Until it does nothing is transcribed: whisper fed
   *  pure silence emits training-data loops rather than nothing. */
  noteSpeech(): void {
    if (this.state.done) return;
    this.state.utterancePending = true;
    this.state.utteranceStartSamples ??= this.ring.absoluteSampleCount;
  }

  /** Silence while no utterance is open: keep only a pre-roll, so the next
   *  onset survives and the quiet is never sent. */
  discardIdleAudio(): void {
    if (this.state.done || this.state.utterancePending || this.state.finalRequested) return;
    const preroll = Math.round((VOICE_PRE_SPEECH_MS / 1000) * this.options.sourceSampleRate);
    this.state.sentSourceSamples = Math.max(
      this.state.sentSourceSamples,
      this.ring.absoluteSampleCount - preroll,
    );
  }

  async start(): Promise<void> {
    const { sessionId } = await this.options.transport.start({
      sampleRate: VOICE_TARGET_SAMPLE_RATE,
      language: this.options.language,
    });
    this.state.sessionId = sessionId;
    this.scheduleTick(VOICE_TICK_MS);
  }

  /** Finalize with everything captured up to now, immediately. */
  requestFinal(): void {
    if (this.state.done) return;
    this.state.finalRequested = true;
    this.state.finalCutSamples ??= this.ring.absoluteSampleCount;
    if (this.cancelTick !== null) {
      this.cancelTick();
      this.cancelTick = null;
    }
    this.scheduleTick(0);
  }

  /** Abandon without a final transcript (user cancelled). */
  async cancel(): Promise<void> {
    this.state.done = true;
    if (this.cancelTick !== null) {
      this.cancelTick();
      this.cancelTick = null;
    }
    const sessionId = this.state.sessionId;
    this.state.sessionId = null;
    if (sessionId !== null) {
      await this.options.transport.close(sessionId).catch(() => undefined);
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.state.done || this.cancelTick !== null) return;
    this.cancelTick = this.options.scheduler.schedule(() => {
      this.cancelTick = null;
      void this.runTick();
    }, delayMs);
  }

  private nextChunk(): { readonly base64: string; readonly byteLength: number } | null {
    if (this.state.pendingChunk !== null) return this.state.pendingChunk;
    const limit = this.state.finalCutSamples ?? this.ring.absoluteSampleCount;
    const fresh = limit - this.state.sentSourceSamples;
    const minSamples = (VOICE_MIN_TICK_MS / 1000) * this.options.sourceSampleRate;
    if (fresh <= 0 || (!this.state.finalRequested && fresh < minSamples)) return null;
    const maxCut = MAX_CHUNK_SOURCE_SECONDS * this.options.sourceSampleRate;
    const cutEnd = Math.min(limit, this.state.sentSourceSamples + maxCut);
    const source = this.ring
      .readFromAbsolute(this.state.sentSourceSamples)
      .subarray(0, cutEnd - this.state.sentSourceSamples);
    const resampled = resampleLinear(
      source,
      this.options.sourceSampleRate,
      VOICE_TARGET_SAMPLE_RATE,
    );
    this.state.sentSourceSamples = cutEnd;
    const chunk = encodeVoicePcm(resampled);
    this.state.pendingChunk = chunk;
    return chunk;
  }

  private remainingFinalBacklog(): number {
    if (this.state.finalCutSamples === null) return 0;
    return Math.max(0, this.state.finalCutSamples - this.state.sentSourceSamples);
  }

  private async finish(close: boolean): Promise<void> {
    this.state.done = true;
    const sessionId = this.state.sessionId;
    this.state.sessionId = null;
    if (close && sessionId !== null) {
      await this.options.transport.close(sessionId).catch(() => undefined);
    }
  }

  private async runTick(): Promise<void> {
    if (this.state.done || this.state.ticking || this.state.sessionId === null) return;
    // Nothing spoken yet; asking whisper to transcribe room noise makes it
    // hallucinate.
    if (!this.state.utterancePending && !this.state.finalRequested) {
      this.scheduleTick(VOICE_TICK_MS);
      return;
    }
    const spokenSamples = this.ring.absoluteSampleCount - (this.state.utteranceStartSamples ?? 0);
    if (
      !this.state.finalRequested &&
      spokenSamples >= MAX_UTTERANCE_SECONDS * this.options.sourceSampleRate
    ) {
      this.state.finalRequested = true;
      this.state.finalCutSamples ??= this.ring.absoluteSampleCount;
    }
    this.state.ticking = true;
    let failed = false;
    try {
      const chunk = this.nextChunk();
      const finalRequested = this.state.finalRequested;
      if (chunk === null && !finalRequested) {
        return;
      }
      // `final` goes out only on the last chunk of the utterance; a retried
      // or capped backlog drains as ordinary appends first.
      const sendFinal = finalRequested && this.remainingFinalBacklog() === 0;
      const transcript = await this.options.transport.append({
        sessionId: this.state.sessionId,
        pcm: chunk?.base64 ?? "",
        offsetBytes: this.state.sentBytes,
        final: sendFinal,
      });
      // Cancelled while the round trip was in flight — the user typed in the
      // draft, or moved on. Delivering now would re-insert an utterance they
      // have already left behind, so this reply belongs to nobody.
      if (this.state.done) return;
      this.state.sentBytes += chunk?.byteLength ?? 0;
      this.state.pendingChunk = null;
      this.state.failedAttempts = 0;
      // The sink is the composer, and a throw from it is a bug there, not a
      // transport failure: counting it as one would end the utterance over a
      // reply the server delivered perfectly well.
      try {
        this.options.onTranscript(transcript);
      } catch (error) {
        this.options.onError(error);
      }
      if (sendFinal) {
        // The server retires the session on a final reply; anything else is
        // a contract violation worth surfacing, but the utterance is over.
        await this.finish(!transcript.isFinal);
        if (!transcript.isFinal) {
          this.options.onError(
            new Error("The final dictation append did not return a final transcript."),
          );
        }
      }
    } catch (error) {
      // Same for a failure: cancelled means nobody is waiting on this session.
      if (this.state.done) return;
      failed = true;
      this.state.failedAttempts += 1;
      const attemptLimit = this.state.finalRequested ? MAX_FINAL_ATTEMPTS : MAX_APPEND_ATTEMPTS;
      const terminal =
        this.options.isTerminalError?.(error) === true || this.state.failedAttempts >= attemptLimit;
      if (terminal) {
        await this.finish(true);
      }
      this.options.onError(error);
    } finally {
      this.state.ticking = false;
      if (!this.state.done) {
        // Drain a final backlog promptly after a success; back off on failure.
        const delay = !failed && this.state.finalRequested ? 0 : VOICE_TICK_MS;
        this.scheduleTick(delay);
      }
    }
  }
}
