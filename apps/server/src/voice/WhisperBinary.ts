import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
// Which libc the host runs is a property of the host, not of either binary;
// both ship as gnu-only Rust builds and share the one detection.
import {
  ResourceMonitorHostLinuxLibc,
  type ResourceMonitorLinuxLibc,
} from "../resourceTelemetry/ResourceMonitorBinary.ts";

export class WhisperBinaryUnsupported extends Schema.TaggedErrorClass<WhisperBinaryUnsupported>()(
  "WhisperBinaryUnsupported",
  {
    platform: Schema.String,
    architecture: Schema.String,
  },
) {
  override get message(): string {
    return `Voice transcription is unsupported on ${this.platform}/${this.architecture}.`;
  }
}

export class WhisperBinaryNotFound extends Schema.TaggedErrorClass<WhisperBinaryNotFound>()(
  "WhisperBinaryNotFound",
  {
    platform: Schema.String,
    architecture: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Whisper sidecar binary was not found for ${this.platform}/${this.architecture}.`;
  }
}

export class WhisperBinaryNotExecutable extends Schema.TaggedErrorClass<WhisperBinaryNotExecutable>()(
  "WhisperBinaryNotExecutable",
  {
    path: Schema.String,
    mode: Schema.Number,
  },
) {
  override get message(): string {
    return `Whisper sidecar binary at '${this.path}' is not executable.`;
  }
}

export type WhisperBinaryError =
  | WhisperBinaryUnsupported
  | WhisperBinaryNotFound
  | WhisperBinaryNotExecutable;

export class WhisperBinary extends Context.Service<
  WhisperBinary,
  {
    readonly resolve: Effect.Effect<string, WhisperBinaryError>;
  }
>()("t3/voice/WhisperBinary") {}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "t3-whisper.exe" : "t3-whisper";
}

export function whisperPlatformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32") ||
    (architecture !== "arm64" && architecture !== "x64")
  ) {
    return undefined;
  }
  return `${platform}-${architecture}`;
}

export function whisperRustTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  linuxLibc?: ResourceMonitorLinuxLibc,
): string | undefined {
  if (platform === "darwin") {
    return architecture === "arm64"
      ? "aarch64-apple-darwin"
      : architecture === "x64"
        ? "x86_64-apple-darwin"
        : undefined;
  }
  if (platform === "linux") {
    // Only gnu builds are published, and a musl host would load one and die on
    // a missing loader; reporting no support gets a clear message instead.
    if (linuxLibc !== "gnu") {
      return undefined;
    }
    return architecture === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : architecture === "x64"
        ? "x86_64-unknown-linux-gnu"
        : undefined;
  }
  if (platform === "win32") {
    return architecture === "arm64"
      ? "aarch64-pc-windows-msvc"
      : architecture === "x64"
        ? "x86_64-pc-windows-msvc"
        : undefined;
  }
  return undefined;
}

export const make = Effect.fn("voice.whisperBinary.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const config = yield* ServerConfig;
  const executableName = binaryName(platform);
  const platformKey = whisperPlatformKey(platform, architecture);
  const linuxLibc = platform === "linux" ? yield* ResourceMonitorHostLinuxLibc : undefined;
  const rustTarget = whisperRustTarget(platform, architecture, linuxLibc);
  // The packaged desktop app stages the binary outside the asar, where no
  // path relative to this module can reach it, so the shell passes it in.
  const overrideCandidates = [environment.T3CODE_WHISPER_PATH, config.whisperPath].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const bundledCandidates =
    platformKey === undefined || rustTarget === undefined
      ? []
      : [
          path.resolve(import.meta.dirname, "whisper", platformKey, executableName),
          path.resolve(import.meta.dirname, "whisper", executableName),
          path.resolve(import.meta.dirname, "../whisper", executableName),
          path.resolve(
            import.meta.dirname,
            "../../../../native/whisper/target",
            rustTarget,
            "release",
            executableName,
          ),
          path.resolve(
            import.meta.dirname,
            "../../../native/whisper/target",
            rustTarget,
            "release",
            executableName,
          ),
          path.resolve(
            import.meta.dirname,
            "../../../../native/whisper/target/release",
            executableName,
          ),
          path.resolve(
            import.meta.dirname,
            "../../../../native/whisper/target/debug",
            executableName,
          ),
        ];
  if (overrideCandidates.length === 0 && bundledCandidates.length === 0) {
    return WhisperBinary.of({
      resolve: Effect.fail(
        new WhisperBinaryUnsupported({
          platform,
          architecture,
        }),
      ),
    });
  }

  const candidates = [...overrideCandidates, ...bundledCandidates];

  const resolve: WhisperBinary["Service"]["resolve"] = Effect.gen(function* () {
    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;

      if (platform !== "win32") {
        const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
        if (Option.isSome(stat) && (stat.value.mode & 0o111) === 0) {
          return yield* new WhisperBinaryNotExecutable({
            path: candidate,
            mode: stat.value.mode,
          });
        }
      }

      return candidate;
    }

    return yield* new WhisperBinaryNotFound({
      platform,
      architecture,
      candidates,
    });
  });

  return WhisperBinary.of({ resolve });
});

export const layer = Layer.effect(WhisperBinary, make());
