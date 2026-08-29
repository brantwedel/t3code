import type {
  VoiceSidecarStatus,
  WhisperSidecarCapabilities,
  WhisperSidecarCommand,
  WhisperSidecarEvent,
  WhisperSidecarHelloEvent,
  WhisperSidecarTranscriptEvent,
} from "@t3tools/contracts";
import {
  WHISPER_SIDECAR_PROTOCOL_VERSION,
  WhisperSidecarCommand as WhisperSidecarCommandSchema,
  WhisperSidecarEvent as WhisperSidecarEventSchema,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as WhisperBinary from "./WhisperBinary.ts";
import { ServerConfig } from "../config.ts";

const HANDSHAKE_TIMEOUT = Duration.seconds(10);
const READY_TIMEOUT = Duration.seconds(20);
const READY_RECHECK_DELAY = Duration.millis(100);
// Model loads read hundreds of megabytes; decodes on a weak CPU take seconds.
const REQUEST_TIMEOUT = Duration.seconds(60);
const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;
const IDLE_CHECK_INTERVAL = Duration.seconds(30);
/** With no sessions and no requests for this long, unload by exiting cleanly. */
const IDLE_STOP_AFTER_MS = 10 * 60_000;

export class WhisperSpawnFailed extends Schema.TaggedErrorClass<WhisperSpawnFailed>()(
  "WhisperSpawnFailed",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to start whisper sidecar '${this.path}'.`;
  }
}

export class WhisperHandshakeTimedOut extends Schema.TaggedErrorClass<WhisperHandshakeTimedOut>()(
  "WhisperHandshakeTimedOut",
  {
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Whisper sidecar handshake timed out after ${this.timeoutMs}ms.`;
  }
}

export class WhisperNotReady extends Schema.TaggedErrorClass<WhisperNotReady>()("WhisperNotReady", {
  timeoutMs: Schema.Number,
}) {
  override get message(): string {
    return `Whisper sidecar did not become ready within ${this.timeoutMs}ms.`;
  }
}

export class WhisperRequestTimedOut extends Schema.TaggedErrorClass<WhisperRequestTimedOut>()(
  "WhisperRequestTimedOut",
  {
    operation: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Whisper sidecar '${this.operation}' request timed out after ${this.timeoutMs}ms.`;
  }
}

export class WhisperProtocolMismatch extends Schema.TaggedErrorClass<WhisperProtocolMismatch>()(
  "WhisperProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Whisper sidecar protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class WhisperDecodeFailed extends Schema.TaggedErrorClass<WhisperDecodeFailed>()(
  "WhisperDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode whisper sidecar output.";
  }
}

export class WhisperCommandFailed extends Schema.TaggedErrorClass<WhisperCommandFailed>()(
  "WhisperCommandFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Whisper sidecar command '${this.operation}' failed.`;
  }
}

export class WhisperRequestFailed extends Schema.TaggedErrorClass<WhisperRequestFailed>()(
  "WhisperRequestFailed",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Whisper sidecar rejected the request (${this.code}): ${this.detail}`;
  }
}

export class WhisperExited extends Schema.TaggedErrorClass<WhisperExited>()("WhisperExited", {
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `Whisper sidecar exited with code ${this.exitCode}.`;
  }
}

export class WhisperStreamClosed extends Schema.TaggedErrorClass<WhisperStreamClosed>()(
  "WhisperStreamClosed",
  {},
) {
  override get message(): string {
    return "Whisper sidecar event stream closed unexpectedly.";
  }
}

export type WhisperSidecarClientError =
  | WhisperBinary.WhisperBinaryError
  | WhisperSpawnFailed
  | WhisperHandshakeTimedOut
  | WhisperNotReady
  | WhisperRequestTimedOut
  | WhisperProtocolMismatch
  | WhisperDecodeFailed
  | WhisperCommandFailed
  | WhisperRequestFailed
  | WhisperExited
  | WhisperStreamClosed;

export interface WhisperSidecarHealth {
  readonly status: VoiceSidecarStatus;
  readonly capabilities: Option.Option<WhisperSidecarCapabilities>;
}

export interface WhisperSessionStartRequest {
  readonly sessionId: string;
  readonly sampleRate: number;
  readonly language?: string | undefined;
  readonly prompt?: string | undefined;
}

export interface WhisperSessionAppendRequest {
  readonly sessionId: string;
  /** base64 int16 LE mono PCM; may be empty on the final flush. */
  readonly pcm: string;
  /** Position of this chunk in the utterance stream; the sidecar dedups on it. */
  readonly offsetBytes: number;
  readonly final: boolean;
}

export class WhisperSidecarClient extends Context.Service<
  WhisperSidecarClient,
  {
    readonly health: Effect.Effect<WhisperSidecarHealth>;
    readonly activeSessions: Effect.Effect<number>;
    readonly loadModel: (path: string) => Effect.Effect<void, WhisperSidecarClientError>;
    readonly sessionStart: (
      request: WhisperSessionStartRequest,
    ) => Effect.Effect<void, WhisperSidecarClientError>;
    readonly sessionAppend: (
      request: WhisperSessionAppendRequest,
    ) => Effect.Effect<WhisperSidecarTranscriptEvent, WhisperSidecarClientError>;
    /** Best-effort; a session on a dead sidecar is already gone. */
    readonly sessionClose: (sessionId: string) => Effect.Effect<void>;
  }
>()("t3/voice/WhisperSidecarClient") {}

type PendingReply = Deferred.Deferred<WhisperSidecarEvent, WhisperRequestFailed>;

interface ClientState {
  readonly status: VoiceSidecarStatus;
  readonly hello: Option.Option<WhisperSidecarHelloEvent>;
  readonly handle: Option.Option<ChildProcessSpawner.ChildProcessHandle>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
  /** Model path the current process has confirmed loaded, for idempotent loads. */
  readonly loadedModelPath: Option.Option<string>;
}

const initialState: ClientState = {
  status: "stopped",
  hello: Option.none(),
  handle: Option.none(),
  lastError: Option.none(),
  restartCount: 0,
  loadedModelPath: Option.none(),
};

export function retainRecentWhisperFailures(
  failures: ReadonlyArray<number>,
  now: number,
): ReadonlyArray<number> {
  return failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS);
}

/** The sidecar may exit only when nothing is mid-utterance and nothing recent. */
export function shouldStopWhisperForIdle(
  activeSessions: number,
  lastActivityAtMs: number,
  nowMs: number,
): boolean {
  return activeSessions === 0 && nowMs - lastActivityAtMs >= IDLE_STOP_AFTER_MS;
}

function restartDelay(attempt: number): Duration.Duration {
  return Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);
}

const decodeSidecarEvent: (
  value: unknown,
) => Effect.Effect<WhisperSidecarEvent, Schema.SchemaError> =
  Schema.decodeUnknownEffect(WhisperSidecarEventSchema);
const encodeSidecarCommand = Schema.encodeEffect(
  Schema.fromJsonString(WhisperSidecarCommandSchema),
);
const isProtocolMismatch = Schema.is(WhisperProtocolMismatch);
const isDecodeFailed = Schema.is(WhisperDecodeFailed);
const isCommandFailed = Schema.is(WhisperCommandFailed);

function eventVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}

/** Sentinel for a clean idle shutdown, distinguished from attempt failures. */
class IdleStop {
  readonly _tag = "IdleStop";
}

export const make = Effect.fn("voice.whisperSidecarClient.make")(function* () {
  const binary = yield* WhisperBinary.WhisperBinary;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const state = yield* Ref.make(initialState);
  const pendingReplies = yield* Ref.make(new Map<string, PendingReply>());
  const sessionCount = yield* Ref.make(0);
  const lastActivityAt = yield* Ref.make(DateTime.toEpochMillis(yield* DateTime.now));
  const demandQueue = yield* Queue.sliding<void>(1);
  const commandMutex = yield* Semaphore.make(1);
  // Hello succeeds the latch, an attempt failure fails it with the real
  // error; only the supervisor swaps it, always resolving the old one first.
  const readyLatch = yield* Ref.make(yield* Deferred.make<void, WhisperSidecarClientError>());

  const noteActivity = DateTime.now.pipe(
    Effect.flatMap((now) => Ref.set(lastActivityAt, DateTime.toEpochMillis(now))),
  );

  const failPending = (error: WhisperRequestFailed) =>
    Effect.gen(function* () {
      const pending = yield* Ref.getAndSet(pendingReplies, new Map());
      yield* Effect.forEach(pending.values(), (deferred) => Deferred.fail(deferred, error), {
        discard: true,
      });
    });

  const writeCommand = (
    handle: ChildProcessSpawner.ChildProcessHandle,
    command: WhisperSidecarCommand,
  ): Effect.Effect<void, WhisperCommandFailed> =>
    commandMutex.withPermits(1)(
      encodeSidecarCommand(command).pipe(
        Effect.map((encoded) => `${encoded}\n`),
        Effect.flatMap((encoded) =>
          Stream.run(Stream.encodeText(Stream.make(encoded)), handle.stdin),
        ),
        Effect.mapError(
          (cause) =>
            new WhisperCommandFailed({
              operation: command.type,
              cause,
            }),
        ),
      ),
    );

  const resolvePending = (
    requestId: string,
    outcome: Result.Result<WhisperSidecarEvent, WhisperRequestFailed>,
  ) =>
    Effect.gen(function* () {
      const deferred = yield* Ref.modify(pendingReplies, (pending) => {
        const next = new Map(pending);
        const current = next.get(requestId);
        next.delete(requestId);
        return [Option.fromUndefinedOr(current), next];
      });
      if (Option.isSome(deferred)) {
        yield* Result.isSuccess(outcome)
          ? Deferred.succeed(deferred.value, outcome.success)
          : Deferred.fail(deferred.value, outcome.failure);
      }
    });

  const processEvent = (
    event: WhisperSidecarEvent,
  ): Effect.Effect<void, WhisperSidecarClientError> => {
    switch (event.type) {
      case "hello":
        return Effect.gen(function* () {
          yield* Ref.update(state, (current) => ({
            ...current,
            status: "healthy" as const,
            hello: Option.some(event),
            lastError: Option.none(),
          }));
          const latch = yield* Ref.get(readyLatch);
          yield* Deferred.succeed(latch, undefined);
        });
      case "ok":
      case "transcript":
        return resolvePending(event.requestId, Result.succeed(event)).pipe(
          Effect.andThen(
            Ref.update(state, (current) =>
              current.status === "degraded"
                ? { ...current, status: "healthy" as const, lastError: Option.none() }
                : current,
            ),
          ),
        );
      case "error": {
        const failure = new WhisperRequestFailed({
          code: event.code,
          detail: event.message,
        });
        const settle =
          event.requestId !== undefined
            ? resolvePending(event.requestId, Result.fail(failure))
            : Effect.void;
        if (!event.recoverable) {
          return settle.pipe(
            Effect.andThen(
              Effect.fail(new WhisperCommandFailed({ operation: event.code, cause: failure })),
            ),
          );
        }
        return settle.pipe(
          Effect.andThen(
            Ref.update(state, (current) => ({
              ...current,
              status: "degraded" as const,
              lastError: Option.some(event.message),
            })),
          ),
        );
      }
    }
  };

  const idleWatch: Effect.Effect<IdleStop> = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(IDLE_CHECK_INTERVAL);
      const sessions = yield* Ref.get(sessionCount);
      const lastActivity = yield* Ref.get(lastActivityAt);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (shouldStopWhisperForIdle(sessions, lastActivity, now)) {
        return new IdleStop();
      }
    }
  });

  const runAttempt: Effect.Effect<IdleStop, WhisperSidecarClientError> = Effect.scoped(
    Effect.gen(function* () {
      const executablePath = yield* binary.resolve;
      const command = ChildProcess.make(executablePath, [], {
        cwd: config.cwd,
        stdin: {
          stream: "pipe",
          endOnDone: false,
        },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      });
      const handle = yield* Effect.acquireRelease(
        spawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) => new WhisperSpawnFailed({ path: executablePath, cause })),
          ),
        (child) => child.kill().pipe(Effect.ignore),
      );
      yield* Ref.update(state, (current) => ({
        ...current,
        status: "starting" as const,
        handle: Option.some(handle),
        hello: Option.none(),
        loadedModelPath: Option.none(),
      }));

      const eventFiber = yield* handle.stdout.pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect(
          (
            value,
          ): Effect.Effect<WhisperSidecarEvent, WhisperProtocolMismatch | WhisperDecodeFailed> => {
            const version = eventVersion(value);
            if (version !== undefined && version !== WHISPER_SIDECAR_PROTOCOL_VERSION) {
              return Effect.fail(
                new WhisperProtocolMismatch({
                  expectedVersion: WHISPER_SIDECAR_PROTOCOL_VERSION,
                  receivedVersion: version,
                }),
              );
            }
            return decodeSidecarEvent(value).pipe(
              Effect.mapError((cause) => new WhisperDecodeFailed({ cause })),
            );
          },
        ),
        Stream.runForEach(processEvent),
        Effect.mapError((cause) =>
          isProtocolMismatch(cause) || isDecodeFailed(cause) || isCommandFailed(cause)
            ? cause
            : new WhisperDecodeFailed({ cause }),
        ),
        Effect.forkScoped,
      );
      // whisper.cpp diagnostics and Rust panics arrive here; draining them into
      // nothing leaves a misbehaving sidecar with no trace at all.
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          line.trim().length === 0
            ? Effect.void
            : Effect.logWarning("whisper sidecar stderr", { line }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );

      const latch = yield* Ref.get(readyLatch);
      yield* Deferred.await(latch).pipe(
        Effect.timeoutOption(HANDSHAKE_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new WhisperHandshakeTimedOut({
                  timeoutMs: Duration.toMillis(HANDSHAKE_TIMEOUT),
                }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const exitEffect = handle.exitCode.pipe(
        Effect.mapError(
          (cause) =>
            new WhisperCommandFailed({
              operation: "waitForExit",
              cause,
            }),
        ),
        Effect.flatMap((exitCode) =>
          Effect.fail(new WhisperExited({ exitCode: Number(exitCode) })),
        ),
      );
      const decoderEffect = Fiber.join(eventFiber).pipe(
        Effect.andThen(Effect.fail(new WhisperStreamClosed())),
      );
      const idleEffect = idleWatch.pipe(
        Effect.tap(() =>
          writeCommand(handle, {
            version: WHISPER_SIDECAR_PROTOCOL_VERSION,
            type: "shutdown",
          }).pipe(Effect.ignore),
        ),
      );
      return yield* Effect.raceFirst(Effect.raceFirst(exitEffect, decoderEffect), idleEffect);
    }),
  ).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* failPending(
          new WhisperRequestFailed({
            code: "sidecar-stopped",
            detail: "The whisper sidecar stopped before replying.",
          }),
        );
        yield* Ref.set(sessionCount, 0);
        yield* Ref.update(state, (current) => ({
          ...current,
          handle: Option.none(),
          hello: Option.none(),
          loadedModelPath: Option.none(),
        }));
      }),
    ),
  );

  const supervisor = Effect.gen(function* () {
    // An exhausted failure budget stays visible as "unavailable" while parked.
    let parkStatus: "stopped" | "unavailable" = "stopped";
    while (true) {
      const parkedAs = parkStatus;
      yield* Ref.update(state, (current) => ({
        ...current,
        status: parkedAs,
      }));
      parkStatus = "stopped";
      // A stale demand token would respawn the sidecar for nobody; live
      // waiters re-offer on their next ready-loop pass.
      yield* Queue.clear(demandQueue);
      yield* Queue.take(demandQueue);
      yield* Ref.set(lastActivityAt, DateTime.toEpochMillis(yield* DateTime.now));

      let failures: ReadonlyArray<number> = [];
      let restartAttempt = 0;
      let running = true;
      while (running) {
        const result = yield* Effect.result(runAttempt);
        if (Result.isSuccess(result)) {
          // Clean idle stop; park with a fresh latch for the next attempt.
          const fresh = yield* Deferred.make<void, WhisperSidecarClientError>();
          yield* Ref.set(readyLatch, fresh);
          running = false;
          break;
        }
        const error = result.failure;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const recentFailures = retainRecentWhisperFailures(failures, now);
        if (recentFailures.length === 0) {
          restartAttempt = 0;
        }
        failures = [...recentFailures, now];
        const exhausted = failures.length >= MAX_FAILURES_PER_WINDOW;
        yield* Ref.update(state, (current) => ({
          ...current,
          status: exhausted ? ("unavailable" as const) : ("degraded" as const),
          lastError: Option.some(error.message),
          restartCount: current.restartCount + 1,
        }));
        const previous = yield* Ref.get(readyLatch);
        yield* Deferred.fail(previous, error).pipe(Effect.ignore);
        const fresh = yield* Deferred.make<void, WhisperSidecarClientError>();
        yield* Ref.set(readyLatch, fresh);
        if (exhausted) {
          parkStatus = "unavailable";
          running = false;
          break;
        }
        yield* Effect.sleep(restartDelay(restartAttempt));
        restartAttempt += 1;
      }
    }
  });
  // A defect escapes `Effect.result` above and would otherwise kill the
  // supervisor outright: status would freeze at whatever it last held, every
  // `awaitReady` would time out against a queue nobody drains, and nothing
  // would say why. Mirrors the resource monitor's guard.
  yield* supervisor.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Ref.update(state, (current) => ({
            ...current,
            status: "unavailable" as const,
            hello: Option.none(),
            lastError: Option.some(Cause.pretty(cause)),
          })).pipe(
            Effect.andThen(
              Effect.logWarning("Whisper sidecar supervisor failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
    ),
    Effect.forkScoped,
  );

  /**
   * Wait for a live handle, waking the supervisor when the sidecar is parked.
   * A latch that resolves without a handle appearing (a stale success from a
   * process that died, or a park) loops after a short delay; an attempt
   * failure propagates immediately with the real error.
   */
  const awaitReady: Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    WhisperSidecarClientError
  > = Effect.gen(function* () {
    while (true) {
      const current = yield* Ref.get(state);
      if (Option.isSome(current.handle) && Option.isSome(current.hello)) {
        return current.handle.value;
      }
      if (Option.isNone(current.handle)) {
        yield* Queue.offer(demandQueue, undefined);
      }
      const latch = yield* Ref.get(readyLatch);
      const resolved = yield* Deferred.await(latch).pipe(
        Effect.as(true),
        Effect.timeoutOption(READY_RECHECK_DELAY),
        Effect.map(Option.isSome),
      );
      if (!resolved) continue;
      const after = yield* Ref.get(state);
      if (Option.isSome(after.handle) && Option.isSome(after.hello)) {
        return after.handle.value;
      }
      yield* Effect.sleep(READY_RECHECK_DELAY);
    }
  }).pipe(
    Effect.timeoutOption(READY_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new WhisperNotReady({ timeoutMs: Duration.toMillis(READY_TIMEOUT) })),
        onSome: Effect.succeed,
      }),
    ),
  );

  const request = Effect.fn("voice.whisperSidecarClient.request")(function* (
    operation: string,
    build: (requestId: string) => WhisperSidecarCommand,
  ): Effect.fn.Return<WhisperSidecarEvent, WhisperSidecarClientError> {
    yield* noteActivity;
    const handle = yield* awaitReady;
    const requestId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new WhisperCommandFailed({ operation, cause })),
    );
    const reply = yield* Deferred.make<WhisperSidecarEvent, WhisperRequestFailed>();
    yield* Ref.update(pendingReplies, (pending) => new Map(pending).set(requestId, reply));
    const removeEntry = Ref.update(pendingReplies, (pending) => {
      const next = new Map(pending);
      next.delete(requestId);
      return next;
    });
    const event = yield* writeCommand(handle, build(requestId)).pipe(
      Effect.andThen(
        Deferred.await(reply).pipe(
          Effect.timeoutOption(REQUEST_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new WhisperRequestTimedOut({
                    operation,
                    timeoutMs: Duration.toMillis(REQUEST_TIMEOUT),
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.ensuring(removeEntry),
    );
    yield* noteActivity;
    return event;
  });

  const loadModel: WhisperSidecarClient["Service"]["loadModel"] = Effect.fn(
    "voice.whisperSidecarClient.loadModel",
  )(function* (path: string) {
    const before = yield* Ref.get(state);
    if (Option.isSome(before.loadedModelPath) && before.loadedModelPath.value === path) {
      return;
    }
    yield* request("loadModel", (requestId) => ({
      version: WHISPER_SIDECAR_PROTOCOL_VERSION,
      type: "loadModel",
      requestId,
      path,
    }));
    // Cache only onto the process generation that answered the load.
    yield* Ref.update(state, (current) =>
      current.restartCount === before.restartCount && Option.isSome(current.handle)
        ? { ...current, loadedModelPath: Option.some(path) }
        : current,
    );
  });

  const sessionStart: WhisperSidecarClient["Service"]["sessionStart"] = Effect.fn(
    "voice.whisperSidecarClient.sessionStart",
  )(function* (input: WhisperSessionStartRequest) {
    yield* request("sessionStart", (requestId) => ({
      version: WHISPER_SIDECAR_PROTOCOL_VERSION,
      type: "sessionStart",
      requestId,
      sessionId: input.sessionId,
      sampleRate: input.sampleRate,
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    }));
    yield* Ref.update(sessionCount, (count) => count + 1);
  });

  const sessionAppend: WhisperSidecarClient["Service"]["sessionAppend"] = Effect.fn(
    "voice.whisperSidecarClient.sessionAppend",
  )(function* (input: WhisperSessionAppendRequest) {
    const event = yield* request("sessionAppend", (requestId) => ({
      version: WHISPER_SIDECAR_PROTOCOL_VERSION,
      type: "sessionAppend",
      requestId,
      sessionId: input.sessionId,
      pcm: input.pcm,
      offsetBytes: input.offsetBytes,
      final: input.final,
    }));
    if (event.type !== "transcript") {
      return yield* new WhisperCommandFailed({
        operation: "sessionAppend",
        cause: `expected a transcript reply, received '${event.type}'`,
      });
    }
    return event;
  });

  const sessionClose: WhisperSidecarClient["Service"]["sessionClose"] = Effect.fn(
    "voice.whisperSidecarClient.sessionClose",
  )(function* (sessionId: string) {
    yield* Ref.update(sessionCount, (count) => Math.max(0, count - 1));
    const current = yield* Ref.get(state);
    if (Option.isNone(current.handle)) return;
    yield* request("sessionClose", (requestId) => ({
      version: WHISPER_SIDECAR_PROTOCOL_VERSION,
      type: "sessionClose",
      requestId,
      sessionId,
    })).pipe(Effect.ignore);
  });

  const health: WhisperSidecarClient["Service"]["health"] = Ref.get(state).pipe(
    Effect.map((current) => ({
      status: current.status,
      capabilities: Option.map(current.hello, (hello) => hello.capabilities),
    })),
  );

  return WhisperSidecarClient.of({
    health,
    activeSessions: Ref.get(sessionCount),
    loadModel,
    sessionStart,
    sessionAppend,
    sessionClose,
  });
});

export const layer = Layer.effect(WhisperSidecarClient, make());
