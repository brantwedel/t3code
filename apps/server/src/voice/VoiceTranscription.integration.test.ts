import * as NodeBuffer from "node:buffer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as VoiceModelStore from "./VoiceModelStore.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";
import * as WhisperBinary from "./WhisperBinary.ts";
import * as WhisperSidecarClient from "./WhisperSidecarClient.ts";

/**
 * Full-stack pass against the real Rust sidecar and a real whisper model.
 * Opt-in because it needs a built binary and a downloaded model:
 *
 *   T3CODE_WHISPER_TEST_MODEL=/path/to/ggml-tiny.en.bin \
 *   T3CODE_WHISPER_TEST_AUDIO=/path/to/speech-16k-mono.s16le \
 *   vp test run src/voice/VoiceTranscription.integration.test.ts
 *
 * Never runs in CI; exists so one command proves the whole stack.
 */
const MODEL_PATH = process.env.T3CODE_WHISPER_TEST_MODEL;
const AUDIO_PATH = process.env.T3CODE_WHISPER_TEST_AUDIO;

describe.skipIf(MODEL_PATH === undefined || AUDIO_PATH === undefined)(
  "VoiceTranscription against the real sidecar",
  () => {
    it.effect(
      "transcribes streamed speech end to end",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-voice-real-",
          });
          const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
          const binaryLayer = WhisperBinary.layer.pipe(
            Layer.provide(configLayer),
            Layer.provide(Layer.succeed(HostProcessEnvironment, process.env)),
          );
          const modelStoreMock = Layer.mock(VoiceModelStore.VoiceModelStore)({
            modelPath: () => MODEL_PATH!,
            isReady: () => Effect.succeed(true),
            statusOfModels: Effect.succeed([]),
          });
          const voiceLayer = VoiceTranscription.layer.pipe(
            Layer.provide(
              WhisperSidecarClient.layer.pipe(
                Layer.provide(binaryLayer),
                Layer.provide(configLayer),
              ),
            ),
            Layer.provide(binaryLayer),
            Layer.provide(modelStoreMock),
            Layer.provide(NodeServices.layer),
          );
          const context = yield* Layer.build(voiceLayer);
          const voice = Context.get(context, VoiceTranscription.VoiceTranscription);

          const audio = yield* fileSystem.readFile(AUDIO_PATH!);
          const pcm = NodeBuffer.Buffer.from(audio);
          const { sessionId } = yield* voice.sessionStart({
            model: "tiny.en",
            sampleRate: 16000,
            language: "en",
          });
          const half = Math.floor(pcm.length / 2) & ~1;
          const partial = yield* voice.sessionAppend({
            sessionId,
            pcm: pcm.subarray(0, half).toString("base64"),
            offsetBytes: 0,
            final: false,
          });
          assert.isFalse(partial.isFinal);
          const final = yield* voice.sessionAppend({
            sessionId,
            pcm: pcm.subarray(half).toString("base64"),
            offsetBytes: half,
            final: true,
          });
          assert.isTrue(final.isFinal);
          assert.isAbove(final.text.length, 0);
          yield* Effect.logInfo("real-model transcript", { text: final.text });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 120_000 },
    );
  },
);
