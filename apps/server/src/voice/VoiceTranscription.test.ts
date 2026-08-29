import * as NodeBuffer from "node:buffer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { VoiceModelId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as VoiceModelStore from "./VoiceModelStore.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";
import * as WhisperBinary from "./WhisperBinary.ts";
import * as WhisperSidecarClient from "./WhisperSidecarClient.ts";
import { isVoiceSessionExpired, resolveVoiceAppendTail } from "./VoiceTranscription.ts";

describe("resolveVoiceAppendTail", () => {
  it("accepts a fresh chunk at the cursor in full", () => {
    expect(resolveVoiceAppendTail(0, 0, 640)).toEqual({ kind: "append", skipBytes: 0 });
    expect(resolveVoiceAppendTail(640, 640, 320)).toEqual({ kind: "append", skipBytes: 0 });
  });

  it("treats a fully replayed chunk as a duplicate", () => {
    expect(resolveVoiceAppendTail(640, 0, 640)).toEqual({ kind: "duplicate" });
    expect(resolveVoiceAppendTail(640, 320, 320)).toEqual({ kind: "duplicate" });
  });

  it("skips only the already-accepted prefix of an overlapping retry", () => {
    expect(resolveVoiceAppendTail(640, 320, 640)).toEqual({ kind: "append", skipBytes: 320 });
  });

  it("rejects a cursor past the accepted count", () => {
    expect(resolveVoiceAppendTail(640, 641, 320)).toEqual({ kind: "mismatch" });
    expect(resolveVoiceAppendTail(0, 1, 0)).toEqual({ kind: "mismatch" });
  });
});

describe("isVoiceSessionExpired", () => {
  it("expires a session only after five idle minutes", () => {
    const start = 1_000_000;
    expect(isVoiceSessionExpired(start, start + 5 * 60_000 - 1)).toBe(false);
    expect(isVoiceSessionExpired(start, start + 5 * 60_000)).toBe(true);
  });
});

/**
 * Fake sidecar speaking the NDJSON protocol. `sessionAppend` replies with the
 * cumulative decoded byte count it has been fed, so the dedup assertions below
 * observe exactly what crossed the process boundary after cursor slicing.
 * CommonJS on purpose: an extensionless shebang script runs as CJS.
 */
const FAKE_SIDECAR_SOURCE = `#!/usr/bin/env node
const VERSION = 1;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
out({
  version: VERSION,
  type: "hello",
  sidecarVersion: "0.0.0-test",
  sidecarPid: process.pid,
  platform: process.platform,
  arch: process.arch,
  capabilities: { backends: ["cpu"], streaming: true, sealing: true },
});
const appended = new Map();
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let index;
  while ((index = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      out({ version: VERSION, type: "error", code: "bad-json", message: "unparseable line", recoverable: true });
      continue;
    }
    switch (command.type) {
      case "loadModel":
        out({ version: VERSION, type: "ok", requestId: command.requestId });
        break;
      case "sessionStart":
        appended.set(command.sessionId, 0);
        out({ version: VERSION, type: "ok", requestId: command.requestId });
        break;
      case "sessionAppend": {
        // Mirror the real sidecar's offset dedup so the byte totals below
        // stay an oracle for both dedup layers.
        const accepted = appended.get(command.sessionId) ?? 0;
        const chunk = Buffer.from(command.pcm || "", "base64");
        const offset = command.offsetBytes ?? accepted;
        const skip = Math.max(0, accepted - offset);
        const total = accepted + Math.max(0, chunk.length - skip);
        appended.set(command.sessionId, total);
        out({
          version: VERSION,
          type: "transcript",
          requestId: command.requestId,
          sessionId: command.sessionId,
          text: "heard " + total + " bytes",
          segments: [{ text: "heard " + total + " bytes", t0Ms: 0, t1Ms: 100 }],
          isFinal: command.final === true,
        });
        break;
      }
      case "sessionClose":
        appended.delete(command.sessionId);
        out({ version: VERSION, type: "ok", requestId: command.requestId });
        break;
      case "shutdown":
        process.exit(0);
        break;
      default:
        out({
          version: VERSION,
          type: "error",
          requestId: command.requestId,
          code: "unknown-command",
          message: "unknown command type",
          recoverable: true,
        });
    }
  }
});
`;

const pcmOfBytes = (bytes: number, fill = 7): string =>
  NodeBuffer.Buffer.alloc(bytes, fill).toString("base64");

/**
 * Builds the full VoiceTranscription stack — real sidecar client speaking to
 * the fake script over real pipes — into the calling test's scope, so the
 * sidecar supervisor fiber stays alive for the duration of the test.
 */
const makeVoiceStack = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-" });
  const sidecarPath = `${baseDir}/fake-whisper`;
  yield* fileSystem.writeFileString(sidecarPath, FAKE_SIDECAR_SOURCE);
  yield* fileSystem.chmod(sidecarPath, 0o755);
  const modelPath = `${baseDir}/ggml-base.en.bin`;
  yield* fileSystem.writeFileString(modelPath, "model");

  const modelStoreMock = Layer.mock(VoiceModelStore.VoiceModelStore)({
    modelPath: () => modelPath,
    isReady: (model: VoiceModelId) => Effect.succeed(model !== "tiny.en"),
    statusOfModels: Effect.succeed([
      { id: "base.en" as const, state: "ready" as const, sizeBytes: 5 },
    ]),
  });
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
  const binaryLayer = WhisperBinary.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { T3CODE_WHISPER_PATH: sidecarPath })),
  );
  const voiceLayer = VoiceTranscription.layer.pipe(
    Layer.provide(
      WhisperSidecarClient.layer.pipe(Layer.provide(binaryLayer), Layer.provide(configLayer)),
    ),
    Layer.provide(binaryLayer),
    Layer.provide(modelStoreMock),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(voiceLayer);
  return Context.get(context, VoiceTranscription.VoiceTranscription);
});

describe("VoiceTranscription with a live fake sidecar", () => {
  it.effect("streams appends, dedups retries, and finalizes a session", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceStack();

      const { sessionId } = yield* voice.sessionStart({ model: "base.en", sampleRate: 16000 });

      const first = yield* voice.sessionAppend({
        sessionId,
        pcm: pcmOfBytes(640),
        offsetBytes: 0,
        final: false,
      });
      assert.equal(first.text, "heard 640 bytes");
      assert.equal(first.isFinal, false);

      // A full replay of the same chunk must not reach the decoder again.
      const replay = yield* voice.sessionAppend({
        sessionId,
        pcm: pcmOfBytes(640),
        offsetBytes: 0,
        final: false,
      });
      assert.equal(replay.text, "heard 640 bytes");

      // An overlapping retry contributes only its unseen tail.
      const overlap = yield* voice.sessionAppend({
        sessionId,
        pcm: pcmOfBytes(640),
        offsetBytes: 320,
        final: false,
      });
      assert.equal(overlap.text, "heard 960 bytes");

      // A cursor past the accepted count is a client bug.
      const mismatch = yield* voice
        .sessionAppend({ sessionId, pcm: pcmOfBytes(320), offsetBytes: 2_000, final: false })
        .pipe(Effect.flip);
      assert.equal(mismatch._tag, "VoiceSessionCursorMismatchError");

      const final = yield* voice.sessionAppend({
        sessionId,
        pcm: pcmOfBytes(320),
        offsetBytes: 960,
        final: true,
      });
      assert.equal(final.text, "heard 1280 bytes");
      assert.equal(final.isFinal, true);

      // A retried final whose reply was lost replays the finalized
      // transcript from the tombstone instead of failing.
      const replayedFinal = yield* voice.sessionAppend({
        sessionId,
        pcm: pcmOfBytes(320),
        offsetBytes: 960,
        final: true,
      });
      assert.equal(replayedFinal.text, "heard 1280 bytes");
      assert.equal(replayedFinal.isFinal, true);

      // The final reply retires the session for everything else.
      const gone = yield* voice
        .sessionAppend({ sessionId, pcm: "", offsetBytes: 1_280, final: false })
        .pipe(Effect.flip);
      assert.equal(gone._tag, "VoiceSessionNotFoundError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to switch models while a session is active", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceStack();
      const { sessionId } = yield* voice.sessionStart({ model: "base.en", sampleRate: 16000 });
      const conflict = yield* voice
        .sessionStart({ model: "small.en", sampleRate: 16000 })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "VoiceTranscriptionFailedError");
      yield* voice.sessionClose(sessionId);
      // With the floor clear, the other model may load.
      const switched = yield* voice.sessionStart({ model: "small.en", sampleRate: 16000 });
      yield* voice.sessionClose(switched.sessionId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports status and refuses a session for a model that is not ready", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceStack();

      const notReady = yield* voice
        .sessionStart({ model: "tiny.en", sampleRate: 16000 })
        .pipe(Effect.flip);
      assert.equal(notReady._tag, "VoiceModelNotReadyError");

      const status = yield* voice.getStatus;
      assert.equal(status.supported, true);
      assert.equal(status.activeSessions, 0);
      assert.deepEqual(
        status.models.map((model) => model.id),
        ["base.en"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closes an abandoned session on request", () =>
    Effect.gen(function* () {
      const voice = yield* makeVoiceStack();
      const { sessionId } = yield* voice.sessionStart({ model: "base.en", sampleRate: 16000 });
      yield* voice.sessionClose(sessionId);
      const gone = yield* voice
        .sessionAppend({ sessionId, pcm: pcmOfBytes(320), offsetBytes: 0, final: false })
        .pipe(Effect.flip);
      assert.equal(gone._tag, "VoiceSessionNotFoundError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("VoiceTranscription without a sidecar binary", () => {
  // The real WhisperBinary resolver would find a locally built
  // `native/whisper/target/**` binary on contributor machines, so the
  // unsupported path is pinned with a mock that always fails resolution.
  const makeUnsupportedStack = Effect.fn(function* () {
    return yield* VoiceTranscription.make().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(WhisperBinary.WhisperBinary)({
            resolve: Effect.fail(
              new WhisperBinary.WhisperBinaryNotFound({
                platform: "darwin",
                architecture: "arm64",
                candidates: [],
              }),
            ),
          }),
          Layer.mock(WhisperSidecarClient.WhisperSidecarClient)({
            health: Effect.succeed({
              status: "stopped" as const,
              capabilities: Option.none(),
            }),
          }),
          Layer.mock(VoiceModelStore.VoiceModelStore)({
            modelPath: (model) => `/nonexistent/ggml-${model}.bin`,
            statusOfModels: Effect.succeed([]),
            isReady: () => Effect.succeed(true),
          }),
        ),
      ),
    );
  });

  it.effect("fails session start and model downloads as unsupported", () =>
    Effect.gen(function* () {
      const voice = yield* makeUnsupportedStack();
      const startError = yield* voice
        .sessionStart({ model: "base.en", sampleRate: 16000 })
        .pipe(Effect.flip);
      assert.equal(startError._tag, "VoiceUnsupportedError");

      const downloadError = yield* voice.ensureModel("base.en").pipe(Stream.runDrain, Effect.flip);
      assert.equal(downloadError._tag, "VoiceUnsupportedError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("busy sessions", () => {
  it.effect("rejects a second append while one is in flight", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-busy-" });
      const modelPath = `${baseDir}/ggml-base.en.bin`;
      yield* fileSystem.writeFileString(modelPath, "model");
      const gate = yield* Deferred.make<void>();

      const voice = yield* VoiceTranscription.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(WhisperSidecarClient.WhisperSidecarClient)({
              loadModel: () => Effect.void,
              sessionStart: () => Effect.void,
              sessionClose: () => Effect.void,
              sessionAppend: () =>
                Deferred.await(gate).pipe(
                  Effect.as({
                    version: 1 as const,
                    type: "transcript" as const,
                    requestId: "r",
                    sessionId: "vs",
                    text: "slow",
                    segments: [],
                    isFinal: false,
                  }),
                ),
            }),
            Layer.mock(WhisperBinary.WhisperBinary)({
              resolve: Effect.succeed(`${baseDir}/fake`),
            }),
            Layer.mock(VoiceModelStore.VoiceModelStore)({
              modelPath: () => modelPath,
              isReady: () => Effect.succeed(true),
            }),
          ),
        ),
      );

      const { sessionId } = yield* voice.sessionStart({ model: "base.en", sampleRate: 16000 });
      const firstAppend = yield* Effect.forkChild(
        voice.sessionAppend({ sessionId, pcm: pcmOfBytes(320), offsetBytes: 0, final: false }),
      );
      // Give the first append a beat to claim the in-flight slot.
      yield* Effect.yieldNow;
      const busy = yield* voice
        .sessionAppend({ sessionId, pcm: pcmOfBytes(320), offsetBytes: 320, final: false })
        .pipe(Effect.flip);
      assert.equal(busy._tag, "VoiceSessionBusyError");
      yield* Deferred.succeed(gate, undefined);
      const first = yield* Fiber.await(firstAppend);
      assert.equal(first._tag, "Success");
      yield* voice.sessionClose(sessionId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
