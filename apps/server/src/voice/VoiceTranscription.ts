import * as NodeBuffer from "node:buffer";

import type {
  VoiceModelProgressEvent,
  VoiceSessionAppendInput,
  VoiceSessionStartInput,
  VoiceSessionStartResult,
  VoiceStatus,
  VoiceTranscript,
} from "@t3tools/contracts";
import {
  VoiceModelDownloadError,
  VoiceModelId,
  VoiceModelNotReadyError,
  VoiceSessionBusyError,
  VoiceSessionCursorMismatchError,
  VoiceSessionId,
  VoiceSessionNotFoundError,
  VoiceTranscriptionFailedError,
  VoiceUnsupportedError,
  normalizeVoiceLanguage,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as VoiceModelStore from "./VoiceModelStore.ts";
import * as WhisperBinary from "./WhisperBinary.ts";
import * as WhisperSidecarClient from "./WhisperSidecarClient.ts";

const SESSION_SWEEP_INTERVAL = Duration.minutes(1);
/** A client that vanishes mid-utterance may not close its session politely. */
const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;
// Finalized transcripts are kept briefly so a client whose final reply was
// lost can retry the final append and still recover its text.
const FINALIZED_TOMBSTONE_TTL_MS = 60_000;
/** Sidecar and decode failures carry arbitrary text; the wire keeps it bounded. */
const MAX_FAILURE_DETAIL_CHARS = 500;
/** A session per utterance, so a few minutes of talking is dozens of them and
 *  only the sweeper reclaims the ones a refresh abandoned. High enough that
 *  real use never reaches it, and reaching it evicts rather than refuses. */
const MAX_ACTIVE_SESSIONS = 64;
/** Speech runs well under this for an utterance of the length the client
 *  allows; the cap only catches a decoder repeating itself. */
const MAX_TRANSCRIPT_CHARS = 8_000;

/** The sidecar no longer knows this session; only a fresh one can recover. */
function isUnknownSessionFailure(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "WhisperRequestFailed" &&
    "code" in cause &&
    cause.code === "unknown-session"
  );
}

function truncateDetail(value: string): string {
  return value.length <= MAX_FAILURE_DETAIL_CHARS
    ? value
    : value.slice(0, MAX_FAILURE_DETAIL_CHARS);
}

export type VoiceAppendTail =
  | { readonly kind: "duplicate" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "append"; readonly skipBytes: number };

/**
 * Decide what part of an incoming chunk is new, from byte counts alone. The
 * cursor advances only after the server accepts audio, so a client retrying a
 * failed append re-sends the same bytes: a chunk fully at or below the
 * accepted count replays the last reply, an overlapping chunk contributes
 * only its unseen tail, and a chunk starting past the accepted count means
 * the client lost audio the server never saw — a bug worth failing loudly.
 */
export function resolveVoiceAppendTail(
  acceptedBytes: number,
  offsetBytes: number,
  chunkBytes: number,
): VoiceAppendTail {
  if (offsetBytes > acceptedBytes) {
    return { kind: "mismatch" };
  }
  if (offsetBytes + chunkBytes <= acceptedBytes) {
    return { kind: "duplicate" };
  }
  return { kind: "append", skipBytes: acceptedBytes - offsetBytes };
}

export function isVoiceSessionExpired(lastTouchedAtMs: number, nowMs: number): boolean {
  return nowMs - lastTouchedAtMs >= SESSION_IDLE_TIMEOUT_MS;
}

interface VoiceSessionState {
  readonly model: VoiceModelId;
  readonly acceptedBytes: number;
  readonly inFlight: boolean;
  readonly lastTranscript: VoiceTranscript;
  readonly lastTouchedAtMs: number;
}

const emptyTranscript: VoiceTranscript = { text: "", segments: [], isFinal: false };

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly getStatus: Effect.Effect<VoiceStatus>;
    readonly ensureModel: (
      model: VoiceModelId,
    ) => Stream.Stream<VoiceModelProgressEvent, VoiceUnsupportedError | VoiceModelDownloadError>;
    readonly sessionStart: (
      input: VoiceSessionStartInput,
    ) => Effect.Effect<
      VoiceSessionStartResult,
      VoiceUnsupportedError | VoiceModelNotReadyError | VoiceTranscriptionFailedError
    >;
    readonly sessionAppend: (
      input: VoiceSessionAppendInput,
    ) => Effect.Effect<
      VoiceTranscript,
      | VoiceSessionNotFoundError
      | VoiceSessionBusyError
      | VoiceSessionCursorMismatchError
      | VoiceTranscriptionFailedError
    >;
    readonly sessionClose: (sessionId: VoiceSessionId) => Effect.Effect<void>;
  }
>()("t3/voice/VoiceTranscription") {}

export const make = Effect.fn("voice.voiceTranscription.make")(function* () {
  const binary = yield* WhisperBinary.WhisperBinary;
  const sidecar = yield* WhisperSidecarClient.WhisperSidecarClient;
  const models = yield* VoiceModelStore.VoiceModelStore;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const sessions = yield* Ref.make(new Map<VoiceSessionId, VoiceSessionState>());
  const finalizedTombstones = yield* Ref.make(
    new Map<VoiceSessionId, { readonly transcript: VoiceTranscript; readonly atMs: number }>(),
  );
  /**
   * Serializes starts. The model-conflict check below is only meaningful if no
   * other start can slip between it and the map entry, and `loadModel` reads
   * hundreds of megabytes in that gap.
   */
  const startLock = yield* Semaphore.make(1);

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const unsupported = (detail: string) =>
    new VoiceUnsupportedError({ platform, architecture, detail });

  const checkSupported: Effect.Effect<void, VoiceUnsupportedError> = binary.resolve.pipe(
    Effect.asVoid,
    Effect.mapError((error) => unsupported(error.message)),
  );

  const transcriptionFailed = (cause: { readonly message: string }) =>
    new VoiceTranscriptionFailedError({ detail: truncateDetail(cause.message) });

  const closeSidecarSession = (sessionId: VoiceSessionId) =>
    sidecar.sessionClose(sessionId).pipe(Effect.ignore);

  const removeSession = (sessionId: VoiceSessionId) =>
    Ref.modify(sessions, (current) => {
      const existing = current.get(sessionId);
      if (existing === undefined) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.delete(sessionId);
      return [true, next] as const;
    });

  const sweepExpiredSessions = Effect.gen(function* () {
    const now = yield* nowMs;
    const current = yield* Ref.get(sessions);
    const expired = [...current.entries()]
      .filter(
        ([, session]) => !session.inFlight && isVoiceSessionExpired(session.lastTouchedAtMs, now),
      )
      .map(([sessionId]) => sessionId);
    yield* Effect.forEach(
      expired,
      (sessionId) =>
        Effect.gen(function* () {
          const removed = yield* removeSession(sessionId);
          if (removed) {
            yield* closeSidecarSession(sessionId);
            yield* Effect.logInfo("voice session expired", { sessionId });
          }
        }),
      { discard: true },
    );
    yield* Ref.update(finalizedTombstones, (tombstones) => {
      const next = new Map(tombstones);
      for (const [sessionId, entry] of next) {
        if (now - entry.atMs >= FINALIZED_TOMBSTONE_TTL_MS) {
          next.delete(sessionId);
        }
      }
      return next;
    });
  });

  /**
   * Make room for one more session by retiring the least recently touched idle
   * ones. Sessions in flight are never touched, so this can only reclaim work
   * nobody is waiting on.
   */
  const evictIdleSessionsForCapacity = Effect.gen(function* () {
    const current = yield* Ref.get(sessions);
    if (current.size < MAX_ACTIVE_SESSIONS) return;
    const stale = [...current.entries()]
      .filter(([, session]) => !session.inFlight)
      .sort(([, left], [, right]) => left.lastTouchedAtMs - right.lastTouchedAtMs)
      .slice(0, current.size - MAX_ACTIVE_SESSIONS + 1)
      .map(([sessionId]) => sessionId);
    yield* Effect.forEach(
      stale,
      (sessionId) =>
        Effect.gen(function* () {
          const removed = yield* removeSession(sessionId);
          if (removed) {
            yield* closeSidecarSession(sessionId);
            yield* Effect.logInfo("voice session evicted to make room", { sessionId });
          }
        }),
      { discard: true },
    );
  });

  // Ignoring per pass, not around the loop: a single failed sweep must not
  // retire the sweeper, or sessions and tombstones grow for the process's life.
  yield* Effect.forkScoped(
    sweepExpiredSessions.pipe(Effect.ignore, Effect.delay(SESSION_SWEEP_INTERVAL), Effect.forever),
  );

  const getStatus: VoiceTranscription["Service"]["getStatus"] = Effect.gen(function* () {
    const supported = yield* binary.resolve.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const health = yield* sidecar.health;
    const modelStatuses = yield* models.statusOfModels;
    const current = yield* Ref.get(sessions);
    return {
      supported,
      sidecar: health.status,
      backends: Option.match(health.capabilities, {
        onNone: () => [] as ReadonlyArray<string>,
        onSome: (capabilities) => capabilities.backends,
      }),
      models: modelStatuses,
      activeSessions: current.size,
    } satisfies VoiceStatus;
  });

  const ensureModel: VoiceTranscription["Service"]["ensureModel"] = (model) =>
    Stream.unwrap(checkSupported.pipe(Effect.as(models.ensureModel(model))));

  const sessionStart: VoiceTranscription["Service"]["sessionStart"] = Effect.fn(
    "voice.voiceTranscription.sessionStart",
  )(function* (input: VoiceSessionStartInput) {
    return yield* startLock.withPermits(1)(startSession(input));
  });

  const startSession = Effect.fn("voice.voiceTranscription.startSession")(function* (
    input: VoiceSessionStartInput,
  ) {
    yield* checkSupported;
    const ready = yield* models.isReady(input.model);
    if (!ready) {
      return yield* new VoiceModelNotReadyError({ model: input.model });
    }
    // Every utterance opens its own session, and a client that navigates away,
    // refreshes, or drops mid-start never closes the one it abandoned. Retire
    // the idle ones to make room rather than refusing to listen: the cap is
    // here to bound decoder state, and someone talking into a microphone must
    // never be the thing that gets turned away.
    yield* evictIdleSessionsForCapacity;
    const active = [...(yield* Ref.get(sessions)).values()];
    const conflicting = active.find((session) => session.model !== input.model);
    if (conflicting !== undefined) {
      return yield* new VoiceTranscriptionFailedError({
        detail: `Another dictation session is using the '${conflicting.model}' model. Try again when it finishes.`,
      });
    }
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.mapError(transcriptionFailed));
    const sessionId = VoiceSessionId.make(`vs-${uuid}`);
    yield* sidecar
      .loadModel(models.modelPath(input.model))
      .pipe(Effect.mapError(transcriptionFailed));
    // The sidecar's session count and our map entry must move together, or
    // a phantom "active" session blocks idle unload forever.
    yield* Effect.uninterruptible(
      sidecar
        .sessionStart({
          sessionId,
          sampleRate: input.sampleRate,
          language: normalizeVoiceLanguage(input.language),
          prompt: input.prompt,
        })
        .pipe(
          Effect.mapError(transcriptionFailed),
          Effect.andThen(
            Effect.gen(function* () {
              const now = yield* nowMs;
              yield* Ref.update(sessions, (current) =>
                new Map(current).set(sessionId, {
                  model: input.model,
                  acceptedBytes: 0,
                  inFlight: false,
                  lastTranscript: emptyTranscript,
                  lastTouchedAtMs: now,
                }),
              );
            }),
          ),
        ),
    );
    return { sessionId } satisfies VoiceSessionStartResult;
  });

  const sessionAppend: VoiceTranscription["Service"]["sessionAppend"] = Effect.fn(
    "voice.voiceTranscription.sessionAppend",
  )(function* (input: VoiceSessionAppendInput) {
    const now = yield* nowMs;
    type AppendClaim =
      | { readonly kind: "missing" }
      | { readonly kind: "busy" }
      | { readonly kind: "claimed"; readonly session: VoiceSessionState };
    // Claim the in-flight slot atomically so two concurrent appends cannot
    // both pass the gate and interleave audio at the sidecar.
    const claim = yield* Ref.modify(
      sessions,
      (current): readonly [AppendClaim, Map<VoiceSessionId, VoiceSessionState>] => {
        const session = current.get(input.sessionId);
        if (session === undefined) {
          return [{ kind: "missing" }, current];
        }
        if (session.inFlight) {
          return [{ kind: "busy" }, current];
        }
        const next = new Map(current);
        next.set(input.sessionId, { ...session, inFlight: true, lastTouchedAtMs: now });
        return [{ kind: "claimed", session }, next];
      },
    );
    if (claim.kind === "missing") {
      if (input.final) {
        const tombstone = (yield* Ref.get(finalizedTombstones)).get(input.sessionId);
        if (tombstone !== undefined) {
          return tombstone.transcript;
        }
      }
      return yield* new VoiceSessionNotFoundError({ sessionId: input.sessionId });
    }
    if (claim.kind === "busy") {
      return yield* new VoiceSessionBusyError({ sessionId: input.sessionId });
    }

    const releaseInFlight = Ref.update(sessions, (current) => {
      const session = current.get(input.sessionId);
      if (session === undefined) return current;
      const next = new Map(current);
      next.set(input.sessionId, { ...session, inFlight: false });
      return next;
    });

    return yield* Effect.gen(function* () {
      const pcm = NodeBuffer.Buffer.from(input.pcm, "base64");
      const tail = resolveVoiceAppendTail(
        claim.session.acceptedBytes,
        input.offsetBytes,
        pcm.byteLength,
      );
      if (tail.kind === "mismatch") {
        return yield* new VoiceSessionCursorMismatchError({
          sessionId: input.sessionId,
          acceptedBytes: claim.session.acceptedBytes,
          offsetBytes: input.offsetBytes,
        });
      }
      if (tail.kind === "duplicate" && !input.final) {
        return claim.session.lastTranscript;
      }
      const newAudio =
        tail.kind === "append" && tail.skipBytes > 0 ? pcm.subarray(tail.skipBytes) : pcm;
      const event = yield* sidecar
        .sessionAppend({
          sessionId: input.sessionId,
          pcm: tail.kind === "duplicate" ? "" : newAudio.toString("base64"),
          offsetBytes: claim.session.acceptedBytes,
          final: input.final,
        })
        .pipe(
          Effect.mapError((cause) =>
            // The sidecar restarted and lost this session. Reported as "not
            // found" so the client retires it at once rather than re-sending
            // the same chunk until the utterance ends.
            isUnknownSessionFailure(cause)
              ? new VoiceSessionNotFoundError({ sessionId: input.sessionId })
              : transcriptionFailed(cause),
          ),
        );
      // A decoder that loops on noise can emit the same phrase until it fills
      // the window; the utterance is already capped in time, so anything past
      // this is a malfunction and is cut rather than relayed and stored.
      const transcript: VoiceTranscript = {
        text:
          event.text.length <= MAX_TRANSCRIPT_CHARS
            ? event.text
            : event.text.slice(0, MAX_TRANSCRIPT_CHARS),
        segments: event.segments,
        isFinal: event.isFinal,
      };
      const acceptedBytes = Math.max(
        claim.session.acceptedBytes,
        input.offsetBytes + pcm.byteLength,
      );
      const touchedAt = yield* nowMs;
      yield* Ref.update(sessions, (current) => {
        const session = current.get(input.sessionId);
        if (session === undefined) return current;
        const next = new Map(current);
        next.set(input.sessionId, {
          ...session,
          acceptedBytes,
          lastTranscript: transcript,
          lastTouchedAtMs: touchedAt,
        });
        return next;
      });
      if (input.final) {
        yield* Ref.update(finalizedTombstones, (tombstones) =>
          new Map(tombstones).set(input.sessionId, { transcript, atMs: touchedAt }),
        );
        const removed = yield* removeSession(input.sessionId);
        if (removed) {
          yield* closeSidecarSession(input.sessionId);
        }
      }
      return transcript;
    }).pipe(Effect.ensuring(releaseInFlight));
  });

  const sessionClose: VoiceTranscription["Service"]["sessionClose"] = Effect.fn(
    "voice.voiceTranscription.sessionClose",
  )(function* (sessionId: VoiceSessionId) {
    const removed = yield* removeSession(sessionId);
    if (removed) {
      yield* closeSidecarSession(sessionId);
    }
  });

  return VoiceTranscription.of({
    getStatus,
    ensureModel,
    sessionStart,
    sessionAppend,
    sessionClose,
  });
});

export const layer = Layer.effect(VoiceTranscription, make());
