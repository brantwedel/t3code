import type { EnvironmentId, VoiceModelId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
  runStreamInEnvironment,
} from "./runtime.ts";

export type VoiceModelDownloadState =
  | { readonly phase: "idle" }
  | { readonly phase: "downloading"; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly phase: "verifying" }
  | { readonly phase: "ready" }
  | { readonly phase: "failed"; readonly message: string };

const IDLE_DOWNLOAD_STATE: VoiceModelDownloadState = { phase: "idle" };

export interface VoiceEnsureModelInput {
  readonly environmentId: EnvironmentId;
  readonly model: VoiceModelId;
}

export function createVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const sessionScheduler = createAtomCommandScheduler();
  const modelDownloadStateAtom = Atom.family((_key: string) =>
    Atom.make<VoiceModelDownloadState>(IDLE_DOWNLOAD_STATE),
  );
  const downloadKey = (input: VoiceEnsureModelInput) => `${input.environmentId}:${input.model}`;

  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:voice:status",
      tag: WS_METHODS.voiceGetStatus,
      staleTimeMs: 5_000,
    }),
    sessionStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:session-start",
      tag: WS_METHODS.voiceSessionStart,
      scheduler: sessionScheduler,
    }),
    sessionAppend: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:session-append",
      tag: WS_METHODS.voiceSessionAppend,
      scheduler: sessionScheduler,
    }),
    sessionClose: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:session-close",
      tag: WS_METHODS.voiceSessionClose,
      scheduler: sessionScheduler,
    }),
    modelDownloadState: (input: VoiceEnsureModelInput) =>
      modelDownloadStateAtom(downloadKey(input)),
    ensureModel: createRuntimeCommand<
      EnvironmentRegistry | R,
      E,
      VoiceEnsureModelInput,
      void,
      unknown
    >(runtime, {
      label: "environment-data:voice:ensure-model",
      concurrency: { mode: "serial", key: downloadKey },
      execute: (input, registry) => {
        const stateAtom = modelDownloadStateAtom(downloadKey(input));
        registry.set(stateAtom, { phase: "downloading", receivedBytes: 0, totalBytes: 0 });
        return runStreamInEnvironment(
          input.environmentId,
          runStream(WS_METHODS.voiceEnsureModel, { model: input.model }),
        ).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              switch (event.type) {
                case "progress":
                  registry.set(stateAtom, {
                    phase: "downloading",
                    receivedBytes: event.receivedBytes,
                    totalBytes: event.totalBytes,
                  });
                  return;
                case "verifying":
                  registry.set(stateAtom, { phase: "verifying" });
                  return;
                case "ready":
                  registry.set(stateAtom, { phase: "ready" });
                  return;
              }
            }),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (!Exit.isFailure(exit)) return;
              const cause = exit.cause;
              const current = registry.get(stateAtom);
              if (current.phase === "ready") return;
              if (Exit.hasInterrupts(exit)) {
                registry.set(stateAtom, IDLE_DOWNLOAD_STATE);
                return;
              }
              const squashed = Cause.squash(cause);
              registry.set(stateAtom, {
                phase: "failed",
                message: squashed instanceof Error ? squashed.message : String(squashed),
              });
            }),
          ),
        );
      },
    }),
  };
}
