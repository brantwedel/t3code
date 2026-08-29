import type { EnvironmentId, VoiceModelId, VoiceSessionId } from "@t3tools/contracts";
import {
  VOICE_RESUME_WINDOW_MS,
  VOICE_TARGET_SAMPLE_RATE,
  VOICE_TICK_MS,
  VoiceSessionDriver,
  frameRmsLevel,
  initialVoiceVadState,
  updateVoiceVad,
  voiceUtteranceEnded,
  type VoiceSessionTransport,
  type VoiceVadState,
} from "@t3tools/client-runtime/voice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useRef, useState, useEffect } from "react";

import { startMicCapture, type MicCaptureHandle } from "./micCapture";
import { voiceEnvironment } from "../state/voice";
import { useAtomCommand } from "../state/use-atom-command";

export type VoiceDictationStatus = "idle" | "starting" | "listening";

export interface VoiceDictationActivity {
  readonly level: number;
  readonly speaking: boolean;
  /** True while the finalize round-trip for the current utterance is running. */
  readonly finalizing: boolean;
}

/** Which environment and model the session runs against; read at `start`. */
export interface VoiceDictationStartInput {
  readonly environmentId: EnvironmentId;
  readonly model: VoiceModelId;
  readonly language: string;
}

/**
 * Fired on every accepted reply. `text` is the FULL transcript of the current
 * utterance, so the sink replaces its span rather than appending, and
 * `utteranceId` rises per utterance so stale replies can be told apart.
 */
export type VoiceTranscriptSink = (text: string, isFinal: boolean, utteranceId: number) => void;

export interface VoiceDictationHandle {
  readonly status: VoiceDictationStatus;
  readonly error: string | null;
  readonly start: (input: VoiceDictationStartInput) => Promise<void>;
  /** Claim the transcripts; returns the release. Composers come and go with the
   *  route, while the session carries on. */
  readonly setTranscriptSink: (sink: VoiceTranscriptSink) => () => void;
  /** Stop listening; the in-flight utterance still finalizes and commits. */
  readonly stop: () => void;
  /** Stop and discard the in-flight utterance entirely. */
  readonly cancel: () => void;
  /**
   * Abandon the utterance in flight and open a fresh session, mic still on. A
   * session's transcript is cumulative, so one whose draft has changed
   * underneath it must be dropped or its next reply re-inserts everything.
   */
  readonly restartUtterance: () => void;
  /** Hold every buffered sample rather than trimming to the pre-roll: someone
   *  holding the button to talk is already speaking. */
  readonly setRetainingAudio: (retaining: boolean) => void;
  /** Poll-friendly snapshot for the live preview; stable identity. */
  readonly getActivity: () => VoiceDictationActivity;
}

/** How long a stopped session may take to flush. Past this it is abandoned:
 *  text arriving under a mic shown as off is worse than losing a tail. */
const FINALIZE_GRACE_MS = 2_500;

/** How much audio is carried across a session handover. Covers the silence
 *  that ended the last utterance plus the round trip opening the next one,
 *  with room to spare — dropping a word costs far more than a stale frame. */
const PREROLL_CARRY_MS = 2_000;

const TERMINAL_ERROR_TAGS = new Set([
  "VoiceSessionNotFoundError",
  "VoiceSessionCursorMismatchError",
  "VoiceUnsupportedError",
  "VoiceModelNotReadyError",
]);

function isTerminalDictationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    TERMINAL_ERROR_TAGS.has(error._tag)
  );
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEnvironmentId(params: VoiceDictationStartInput | null): EnvironmentId {
  if (params === null) throw new Error("Dictation used without session parameters.");
  return params.environmentId;
}

/**
 * Owns the microphone, the VAD, and a chain of dictation sessions: each
 * silence-terminated utterance finalizes its own, and the next starts fresh
 * while the mic stays open.
 */
export function useVoiceDictation(): VoiceDictationHandle {
  const [status, setStatus] = useState<VoiceDictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const sessionStartCommand = useAtomCommand(voiceEnvironment.sessionStart, {
    reportFailure: false,
  });
  const sessionAppendCommand = useAtomCommand(voiceEnvironment.sessionAppend, {
    reportFailure: false,
    reportDefect: false,
  });
  const sessionCloseCommand = useAtomCommand(voiceEnvironment.sessionClose, {
    reportFailure: false,
  });

  const paramsRef = useRef<VoiceDictationStartInput | null>(null);
  const sinkRef = useRef<VoiceTranscriptSink | null>(null);
  const activeRef = useRef(false);
  /** Set at stop: the flush may still land, but nothing before it. */
  const suppressPartialsRef = useRef(false);
  const finalizeTimerRef = useRef<number | null>(null);
  const captureRef = useRef<MicCaptureHandle | null>(null);
  /** The one driver allowed to write to the draft. */
  const driverRef = useRef<VoiceSessionDriver | null>(null);
  const vadRef = useRef<VoiceVadState>(initialVoiceVadState);
  const finalRequestedRef = useRef(false);
  /**
   * Audio captured while no driver is listening. A driver is per utterance and
   * starts with an empty ring, so between one finalizing and the next session
   * opening — an RPC round trip — there is nothing to push frames into, and
   * whatever was said in that gap used to be dropped on the floor. Frames are
   * always retained here and replayed into the next driver, which is what makes
   * the first words of an utterance survive.
   */
  const prerollRef = useRef<{
    frames: Float32Array[];
    samples: number;
    sampleRate: number;
    hadSpeech: boolean;
  }>({ frames: [], samples: 0, sampleRate: VOICE_TARGET_SAMPLE_RATE, hadSpeech: false });
  /** Monotonic across the hook's life; never reused, so stale replies sort low. */
  const utteranceIdRef = useRef(0);
  const retainAudioRef = useRef(false);
  const levelRef = useRef(0);
  const startUtteranceRef = useRef<((sampleRate: number) => void) | null>(null);

  const transport = useMemo<VoiceSessionTransport>(
    () => ({
      start: async (input) => {
        const params = paramsRef.current;
        if (params === null) throw new Error("Dictation started without session parameters.");
        const result = await sessionStartCommand({
          environmentId: params.environmentId,
          input: {
            model: params.model,
            sampleRate: input.sampleRate,
            ...(input.language !== undefined && input.language !== ""
              ? { language: input.language }
              : {}),
          },
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        return { sessionId: result.value.sessionId };
      },
      append: async (input) => {
        const result = await sessionAppendCommand({
          environmentId: requireEnvironmentId(paramsRef.current),
          input,
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        return result.value;
      },
      close: async (sessionId: VoiceSessionId) => {
        await sessionCloseCommand({
          environmentId: requireEnvironmentId(paramsRef.current),
          input: { sessionId },
        });
      },
    }),
    [sessionAppendCommand, sessionCloseCommand, sessionStartCommand],
  );

  const clearFinalizeTimer = useCallback(() => {
    if (finalizeTimerRef.current === null) return;
    window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
  }, []);

  /** Disown a driver so it can no longer reach the draft, then close it. */
  const releaseDriver = useCallback((driver: VoiceSessionDriver | null) => {
    if (driverRef.current === driver) driverRef.current = null;
    if (driver !== null && !driver.isDone) void driver.cancel();
  }, []);

  const teardown = useCallback(
    (mode: "finalize" | "cancel") => {
      activeRef.current = false;
      captureRef.current?.stop();
      captureRef.current = null;
      clearFinalizeTimer();
      const driver = driverRef.current;
      if (mode === "finalize" && driver !== null && !driver.isDone) {
        // Stop means stop: only the flush already spoken may still land, and
        // only if it comes back quickly.
        suppressPartialsRef.current = true;
        driver.requestFinal();
        finalizeTimerRef.current = window.setTimeout(() => {
          finalizeTimerRef.current = null;
          releaseDriver(driver);
        }, FINALIZE_GRACE_MS);
      } else {
        releaseDriver(driver);
      }
      levelRef.current = 0;
      retainAudioRef.current = false;
      setStatus("idle");
    },
    [clearFinalizeTimer, releaseDriver],
  );

  const startUtterance = useCallback(
    (sampleRate: number) => {
      if (!activeRef.current) return;
      vadRef.current = initialVoiceVadState;
      finalRequestedRef.current = false;
      utteranceIdRef.current += 1;
      const utteranceId = utteranceIdRef.current;
      const driver = new VoiceSessionDriver({
        transport,
        scheduler: {
          schedule: (run, delayMs) => {
            const handle = window.setTimeout(run, delayMs);
            return () => window.clearTimeout(handle);
          },
        },
        sourceSampleRate: sampleRate,
        language:
          paramsRef.current === null || paramsRef.current.language === ""
            ? undefined
            : paramsRef.current.language,
        isTerminalError: isTerminalDictationError,
        onTranscript: (transcript) => {
          // Only the driver we still own may write; a replaced or flushed one
          // must never surface text under a mic shown as off.
          if (driverRef.current !== driver) return;
          if (suppressPartialsRef.current && !transcript.isFinal) return;
          setError(null);
          sinkRef.current?.(transcript.text, transcript.isFinal, utteranceId);
          // A command that rewrote the draft restarts the chain itself;
          // starting a second one here strands this session open.
          if (driverRef.current !== driver) return;
          if (!transcript.isFinal) return;
          if (activeRef.current) {
            startUtterance(sampleRate);
          } else {
            // The flush the user's stop asked for has landed; nothing more.
            clearFinalizeTimer();
            releaseDriver(driver);
          }
        },
        onError: (cause) => {
          if (driverRef.current !== driver) return;
          setError(errorMessageOf(cause));
          // A driver that gave up would leave the mic open with nothing
          // consuming audio.
          if (!driver.isDone) return;
          clearFinalizeTimer();
          releaseDriver(driver);
          if (activeRef.current) {
            startUtteranceRef.current?.(sampleRate);
          }
        },
      });
      driverRef.current = driver;
      // Hand over everything said since the last cut, before a single live
      // frame arrives. Without this the utterance starts at whenever this
      // driver happened to be constructed, which is mid-word.
      const preroll = prerollRef.current;
      for (const frame of preroll.frames) driver.pushAudio(frame);
      if (preroll.hadSpeech) {
        // The gate is reset per utterance and takes its attack time to reopen;
        // by then `discardIdleAudio` would have trimmed the words back off.
        driver.noteSpeech();
        // Opening the utterance without restarting the silence clock strands
        // it: `voiceUtteranceEnded` needs a `lastSpeechAtMs`, and the reset
        // above cleared it. With none, the final never fires and every command
        // spoken into that utterance is silently never run.
        vadRef.current = { ...vadRef.current, lastSpeechAtMs: performance.now() };
      }
      // A session that cannot be opened yet keeps the mic and this driver, so
      // audio spoken during a reconnect or a network handover buffers and goes
      // out once the server answers. Only a drop outlasting the window, or an
      // error retrying cannot fix, ends dictation.
      const attemptStart = (deadline: number) => {
        driver.start().catch((cause: unknown) => {
          if (driverRef.current !== driver || !activeRef.current) return;
          setError(errorMessageOf(cause));
          if (isTerminalDictationError(cause) || Date.now() >= deadline) {
            teardown("cancel");
            return;
          }
          window.setTimeout(() => {
            if (driverRef.current !== driver || !activeRef.current) return;
            attemptStart(deadline);
          }, VOICE_TICK_MS);
        });
      };
      attemptStart(Date.now() + VOICE_RESUME_WINDOW_MS);
    },
    [teardown, transport],
  );
  useEffect(() => {
    startUtteranceRef.current = startUtterance;
  }, [startUtterance]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    teardown("finalize");
  }, [teardown]);

  const cancel = useCallback(() => {
    teardown("cancel");
  }, [teardown]);

  // A refresh or a closed tab otherwise leaves the session open on the server
  // until the idle sweeper runs minutes later, and every utterance opens one of
  // its own. `pagehide` rather than `beforeunload`: it is the one that fires on
  // mobile Safari and on back/forward navigation.
  useEffect(() => {
    const closeOnUnload = () => {
      if (!activeRef.current && driverRef.current === null) return;
      teardown("cancel");
    };
    window.addEventListener("pagehide", closeOnUnload);
    return () => window.removeEventListener("pagehide", closeOnUnload);
  }, [teardown]);

  const setRetainingAudio = useCallback((retaining: boolean) => {
    retainAudioRef.current = retaining;
  }, []);

  const restartUtterance = useCallback(() => {
    const driver = driverRef.current;
    if (driver === null || driver.isDone) return;
    // Drop what is mid-flight rather than letting it land on a draft it no
    // longer describes.
    releaseDriver(driver);
    const capture = captureRef.current;
    if (capture !== null && activeRef.current) {
      startUtterance(capture.sampleRate);
    }
  }, [releaseDriver, startUtterance]);

  const setTranscriptSink = useCallback((sink: VoiceTranscriptSink) => {
    sinkRef.current = sink;
    return () => {
      // On a route change the incoming composer claims the stream before the
      // outgoing one lets go, so only release what is still ours.
      if (sinkRef.current === sink) sinkRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (input: VoiceDictationStartInput) => {
      if (activeRef.current) return;
      paramsRef.current = input;
      setError(null);
      setStatus("starting");
      activeRef.current = true;
      suppressPartialsRef.current = false;
      try {
        const capture = await startMicCapture((frame) => {
          const preroll = prerollRef.current;
          const driver = driverRef.current;
          const listening = driver !== null && !driver.isDone;
          if (listening) driver.pushAudio(frame);
          levelRef.current = frameRmsLevel(frame);
          const now = performance.now();
          const previous = vadRef.current;
          vadRef.current = updateVoiceVad(previous, levelRef.current, now);
          if (listening) {
            if (vadRef.current.speaking) {
              // Opens the transcription gate; until it does, room noise is
              // discarded rather than sent to whisper, which would hallucinate.
              driver.noteSpeech();
            } else if (!retainAudioRef.current && vadRef.current.lastSpeechAtMs === null) {
              driver.discardIdleAudio();
            }
            if (!finalRequestedRef.current && voiceUtteranceEnded(vadRef.current, now)) {
              finalRequestedRef.current = true;
              driver.requestFinal();
              // The cut is frozen here, so nothing from this point reaches the
              // finalizing session. It belongs to the next one instead.
              preroll.frames = [];
              preroll.samples = 0;
              preroll.hadSpeech = false;
            }
          }
          // Kept whether or not anyone is listening — that gap is the point.
          preroll.frames.push(frame);
          preroll.samples += frame.length;
          preroll.hadSpeech = preroll.hadSpeech || vadRef.current.speaking;
          const limit = Math.round((PREROLL_CARRY_MS / 1000) * preroll.sampleRate);
          while (preroll.samples > limit && preroll.frames.length > 1) {
            const dropped = preroll.frames.shift();
            if (dropped !== undefined) preroll.samples -= dropped.length;
          }
        });
        prerollRef.current.sampleRate = capture.sampleRate;
        if (!activeRef.current) {
          capture.stop();
          return;
        }
        captureRef.current = capture;
        startUtterance(capture.sampleRate);
        setStatus("listening");
      } catch (cause) {
        setError(errorMessageOf(cause));
        teardown("cancel");
      }
    },
    [startUtterance, teardown],
  );

  const getActivity = useCallback(
    (): VoiceDictationActivity => ({
      level: levelRef.current,
      speaking: vadRef.current.speaking,
      finalizing: finalRequestedRef.current && driverRef.current !== null,
    }),
    [],
  );

  useEffect(() => () => teardown("cancel"), [teardown]);

  return {
    status,
    error,
    start,
    stop,
    cancel,
    restartUtterance,
    setRetainingAudio,
    setTranscriptSink,
    getActivity,
  };
}
