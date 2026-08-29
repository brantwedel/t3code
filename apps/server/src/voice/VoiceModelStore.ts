import * as NodeCrypto from "node:crypto";

import type { VoiceModelProgressEvent, VoiceModelStatus } from "@t3tools/contracts";
import { VoiceModelDownloadError, VoiceModelId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";

/** Download failures carry arbitrary text; the wire keeps it bounded. */
const MAX_FAILURE_DETAIL_CHARS = 500;

/**
 * Upstream ggml conversions of the OpenAI whisper models, digest-pinned so a
 * corrupt download fails here rather than deep inside the decoder. Files are
 * renamed into place only after a full digest check, so presence-plus-size
 * stands in for re-hashing on status reads.
 */
export const VOICE_MODEL_CATALOG: Readonly<
  Record<
    VoiceModelId,
    { readonly url: string; readonly sha256: string; readonly sizeBytes: number }
  >
> = {
  "tiny.en": {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    sizeBytes: 77_704_715,
  },
  "base.en": {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    sizeBytes: 147_964_211,
  },
  "small.en": {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    sizeBytes: 487_614_201,
  },
};

export const VOICE_MODEL_IDS = Object.keys(VOICE_MODEL_CATALOG) as ReadonlyArray<VoiceModelId>;

export class VoiceModelStore extends Context.Service<
  VoiceModelStore,
  {
    readonly modelPath: (model: VoiceModelId) => string;
    readonly statusOfModels: Effect.Effect<ReadonlyArray<VoiceModelStatus>>;
    readonly isReady: (model: VoiceModelId) => Effect.Effect<boolean>;
    /**
     * Download, verify, and install a model, ending with a `ready` event.
     * Concurrent calls serialize on one download at a time.
     */
    readonly ensureModel: (
      model: VoiceModelId,
    ) => Stream.Stream<VoiceModelProgressEvent, VoiceModelDownloadError>;
  }
>()("t3/voice/VoiceModelStore") {}

export const make = Effect.fn("voice.voiceModelStore.make")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const downloadMutex = yield* Semaphore.make(1);
  const downloading = yield* Ref.make<ReadonlySet<VoiceModelId>>(new Set());

  const cacheDir = path.join(config.baseDir, "caches", "whisper");
  const modelPath = (model: VoiceModelId) => path.join(cacheDir, `ggml-${model}.bin`);

  /** Leftovers from a download the process did not survive. */
  const discardPartFiles = (model: VoiceModelId) =>
    fileSystem.readDirectory(cacheDir).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(
          names.filter((name) => name.startsWith(`ggml-${model}.bin.`) && name.endsWith(".part")),
          (name) => fileSystem.remove(path.join(cacheDir, name), { force: true }),
          { discard: true },
        ),
      ),
      Effect.ignore,
    );

  const isReady = (model: VoiceModelId) =>
    Effect.gen(function* () {
      const entry = VOICE_MODEL_CATALOG[model];
      const stat = yield* fileSystem.stat(modelPath(model)).pipe(Effect.option);
      return stat._tag === "Some" && Number(stat.value.size) === entry.sizeBytes;
    });

  const statusOfModels: VoiceModelStore["Service"]["statusOfModels"] = Effect.gen(function* () {
    const inFlight = yield* Ref.get(downloading);
    return yield* Effect.forEach(VOICE_MODEL_IDS, (model) =>
      Effect.gen(function* () {
        const ready = yield* isReady(model);
        return {
          id: model,
          state: ready
            ? ("ready" as const)
            : inFlight.has(model)
              ? ("downloading" as const)
              : ("not-downloaded" as const),
          sizeBytes: VOICE_MODEL_CATALOG[model].sizeBytes,
        };
      }),
    );
  });

  const isVoiceModelDownloadError = Schema.is(VoiceModelDownloadError);

  const downloadError = (model: VoiceModelId, detail: string) =>
    // Bounded: a defect stringifies to arbitrary length and this crosses the wire.
    new VoiceModelDownloadError({ model, detail: detail.slice(0, MAX_FAILURE_DETAIL_CHARS) });

  const runDownload = (
    model: VoiceModelId,
    emit: (event: VoiceModelProgressEvent) => Effect.Effect<void>,
  ): Effect.Effect<void, VoiceModelDownloadError> =>
    Effect.gen(function* () {
      const entry = VOICE_MODEL_CATALOG[model];
      const finalPath = modelPath(model);
      const partPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
      yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
      // `ensuring` cannot run if the process is killed mid-download, and each
      // survivor is up to half a gigabyte, so clear any before starting.
      yield* discardPartFiles(model);

      const response = yield* httpClient
        .get(entry.url)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));

      const hash = NodeCrypto.createHash("sha256");
      let receivedBytes = 0;
      let lastReportedBytes = 0;
      yield* Effect.gen(function* () {
        yield* Stream.run(
          response.stream.pipe(
            Stream.mapEffect((chunk) =>
              Effect.gen(function* () {
                hash.update(chunk);
                receivedBytes += chunk.byteLength;
                if (receivedBytes - lastReportedBytes >= 4 * 1024 * 1024) {
                  lastReportedBytes = receivedBytes;
                  yield* emit({
                    type: "progress",
                    model,
                    receivedBytes,
                    totalBytes: entry.sizeBytes,
                  });
                }
                return chunk;
              }),
            ),
          ),
          fileSystem.sink(partPath),
        );
        if (receivedBytes !== entry.sizeBytes) {
          return yield* downloadError(
            model,
            `download was ${receivedBytes} bytes, expected ${entry.sizeBytes}`,
          );
        }
        yield* emit({ type: "verifying", model });
        const digest = hash.digest("hex");
        if (digest !== entry.sha256) {
          return yield* downloadError(model, `sha256 mismatch (got ${digest})`);
        }
        yield* fileSystem.rename(partPath, finalPath);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isVoiceModelDownloadError(cause)
          ? cause
          : downloadError(model, cause instanceof Error ? cause.message : String(cause)),
      ),
    );

  const ensureModel: VoiceModelStore["Service"]["ensureModel"] = (model) =>
    Stream.callback<VoiceModelProgressEvent, VoiceModelDownloadError>((queue) =>
      Effect.gen(function* () {
        const emit = (event: VoiceModelProgressEvent) =>
          Queue.offer(queue, event).pipe(Effect.asVoid);
        // An installed model must answer instantly even while another
        // model's multi-minute download holds the mutex.
        const readyUpFront = yield* isReady(model);
        if (!readyUpFront) {
          yield* downloadMutex.withPermits(1)(
            Effect.gen(function* () {
              const readyNow = yield* isReady(model);
              if (readyNow) return;
              yield* Ref.update(downloading, (current) => new Set(current).add(model));
              yield* runDownload(model, emit).pipe(
                Effect.ensuring(
                  Ref.update(downloading, (current) => {
                    const next = new Set(current);
                    next.delete(model);
                    return next;
                  }),
                ),
              );
            }),
          );
        }
        yield* emit({ type: "ready", model });
      }).pipe(
        Effect.catchTags({
          VoiceModelDownloadError: (error) => Queue.fail(queue, error),
        }),
        Effect.andThen(Queue.end(queue)),
        Effect.forkScoped,
      ),
    );

  return VoiceModelStore.of({
    modelPath,
    statusOfModels,
    isReady,
    ensureModel,
  });
});

export const layer = Layer.effect(VoiceModelStore, make());
