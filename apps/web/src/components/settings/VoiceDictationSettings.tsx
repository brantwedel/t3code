import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  VoiceCommandAction,
  VoiceCommandSetting,
  VoiceModelId,
  KeybindingCommand,
} from "@t3tools/contracts";
import {
  DEFAULT_VOICE_COMMANDS,
  VOICE_COMMAND_DEBOUNCE_MS,
  MAX_VOICE_COMMANDS_COUNT,
  STATIC_KEYBINDING_COMMANDS,
  withMissingVoiceCommands,
  VoiceModelId as VoiceModelIdSchema,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceEnvironment } from "../../state/voice";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { randomUUID } from "~/lib/utils";

const isVoiceModelId = Schema.is(VoiceModelIdSchema);

const VOICE_MODEL_LABELS: Record<VoiceModelId, string> = {
  "tiny.en": "Tiny — 75 MB, fastest",
  "base.en": "Base — 142 MB, recommended",
  "small.en": "Small — 466 MB, most accurate",
};

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

const VOICE_COMMAND_ACTIONS: ReadonlyArray<{
  readonly action: VoiceCommandAction;
  readonly label: string;
}> = [
  { action: "send", label: "Send" },
  { action: "clear", label: "Clear" },
  { action: "newLine", label: "New line" },
  { action: "undo", label: "Undo" },
  { action: "redo", label: "Redo" },
  { action: "stop", label: "Stop dictating" },
  { action: "caretStart", label: "Go to start" },
  { action: "caretEnd", label: "Go to end" },
  { action: "caretPreviousLine", label: "Previous line" },
  { action: "caretNextLine", label: "Next line" },
  { action: "deleteLine", label: "Delete line" },
  { action: "deleteSentence", label: "Delete sentence" },
  { action: "deleteLastSentence", label: "Delete last sentence" },
];

function phrasesOf(
  commands: ReadonlyArray<VoiceCommandSetting>,
  action: VoiceCommandAction,
): string {
  return (commands.find((command) => command.action === action)?.phrases ?? []).join(", ");
}

function withPhrases(
  commands: ReadonlyArray<VoiceCommandSetting>,
  action: VoiceCommandAction,
  input: string,
): ReadonlyArray<VoiceCommandSetting> {
  const phrases = input
    .split(",")
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
  const existing = commands.find((command) => command.action === action);
  // Rewrite in place: reordering would make the list differ from the defaults
  // even when every phrase still matches. Clearing keeps the entry with no
  // phrases, so disabling a command is recorded rather than looking like a
  // setting saved before the command existed — which would restore it.
  if (existing === undefined) {
    return [...commands, { action, phrases, delayMs: defaultDelayFor(action) }];
  }
  return commands.map((command) => (command.action === action ? { ...command, phrases } : command));
}

/**
 * Replacements are addressed by position, not action: they all share `insert`,
 * and a user can keep as many as they like.
 */
function withCommandAt(
  commands: ReadonlyArray<VoiceCommandSetting>,
  index: number,
  patch: Partial<VoiceCommandSetting>,
): ReadonlyArray<VoiceCommandSetting> {
  return commands.map((command, position) =>
    position === index ? { ...command, ...patch } : command,
  );
}

function withoutCommandAt(
  commands: ReadonlyArray<VoiceCommandSetting>,
  index: number,
): ReadonlyArray<VoiceCommandSetting> {
  return commands.filter((_, position) => position !== index);
}

function parsePhrases(input: string): ReadonlyArray<string> {
  return input
    .split(",")
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
}

function withDelay(
  commands: ReadonlyArray<VoiceCommandSetting>,
  action: VoiceCommandAction,
  delayMs: number,
): ReadonlyArray<VoiceCommandSetting> {
  return commands.map((command) => (command.action === action ? { ...command, delayMs } : command));
}

function defaultDelayFor(action: VoiceCommandAction): number {
  return DEFAULT_VOICE_COMMANDS.find((command) => command.action === action)?.delayMs ?? 0;
}

function delayOf(commands: ReadonlyArray<VoiceCommandSetting>, action: VoiceCommandAction): number {
  return commands.find((command) => command.action === action)?.delayMs ?? 0;
}

function ModelDownloadControl(props: {
  readonly environmentId: EnvironmentId;
  readonly model: VoiceModelId;
  readonly modelReady: boolean;
  readonly modelSizeBytes: number | undefined;
  readonly onDownloaded: () => void;
}) {
  const downloadState = useAtomValue(
    voiceEnvironment.modelDownloadState({
      environmentId: props.environmentId,
      model: props.model,
    }),
  );
  const ensureModel = useAtomCommand(voiceEnvironment.ensureModel, { reportFailure: false });

  if (props.modelReady || downloadState.phase === "ready") {
    return <span className="text-xs text-muted-foreground">Downloaded</span>;
  }
  if (downloadState.phase === "downloading" && downloadState.totalBytes > 0) {
    const percent = Math.min(
      100,
      Math.round((downloadState.receivedBytes / downloadState.totalBytes) * 100),
    );
    return (
      <div className="flex w-full items-center gap-2 sm:w-40">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
      </div>
    );
  }
  if (downloadState.phase === "downloading" || downloadState.phase === "verifying") {
    return (
      <span className="text-xs text-muted-foreground">
        {downloadState.phase === "verifying" ? "Verifying…" : "Starting download…"}
      </span>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          void ensureModel({ environmentId: props.environmentId, model: props.model }).then(
            (result) => {
              if (result._tag === "Success") {
                props.onDownloaded();
              }
            },
          );
        }}
      >
        Download
        {props.modelSizeBytes !== undefined ? ` (${formatMegabytes(props.modelSizeBytes)})` : ""}
      </Button>
      {downloadState.phase === "failed" ? (
        <span className="text-xs text-destructive" role="alert">
          {downloadState.message}
        </span>
      ) : null}
    </div>
  );
}

export function VoiceDictationSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const environmentId = usePrimaryEnvironmentId();
  const enabled = settings.voiceDictationEnabled;
  const status = useEnvironmentQuery(
    enabled && environmentId !== null
      ? voiceEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const supported = status.data?.supported;
  // The same list the composer matches against, so a built-in the saved
  // settings predate shows its real phrases rather than looking disabled.
  const voiceCommands = withMissingVoiceCommands(settings.voiceDictationCommands);
  const commandsAreCustomized =
    JSON.stringify(voiceCommands) !== JSON.stringify(DEFAULT_VOICE_COMMANDS);

  return (
    <SettingsSection title="Voice dictation">
      <SettingsRow
        {...searchableSetting("voice-dictation")}
        description="Dictate into the composer. Speech is transcribed by a whisper model running on the connected T3 Code server — audio never leaves your machines."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ voiceDictationEnabled: Boolean(checked) })
            }
            aria-label="Enable voice dictation"
          />
        }
      />
      {enabled ? (
        <>
          {supported === false ? (
            <p className="text-xs text-muted-foreground">
              The connected server has no whisper sidecar for its platform, so dictation is
              unavailable in this environment.
            </p>
          ) : null}
          <SettingsRow
            {...searchableSetting("voice-dictation-model")}
            description="Larger models transcribe more accurately and need more memory on the server."
            resetAction={
              settings.voiceDictationModel !== DEFAULT_UNIFIED_SETTINGS.voiceDictationModel ? (
                <SettingResetButton
                  label="voice model"
                  onClick={() =>
                    updateSettings({
                      voiceDictationModel: DEFAULT_UNIFIED_SETTINGS.voiceDictationModel,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.voiceDictationModel}
                onValueChange={(value) => {
                  if (isVoiceModelId(value)) {
                    updateSettings({ voiceDictationModel: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Voice dictation model">
                  <SelectValue>{VOICE_MODEL_LABELS[settings.voiceDictationModel]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(VOICE_MODEL_LABELS).map(([id, label]) => (
                    <SelectItem key={id} hideIndicator value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {environmentId !== null ? (
            <SettingsRow
              title="Model download"
              description="The selected model is stored on the connected server and downloaded once."
              control={
                <ModelDownloadControl
                  environmentId={environmentId}
                  model={settings.voiceDictationModel}
                  modelReady={
                    status.data?.models.some(
                      (entry) =>
                        entry.id === settings.voiceDictationModel && entry.state === "ready",
                    ) === true
                  }
                  modelSizeBytes={
                    status.data?.models.find((entry) => entry.id === settings.voiceDictationModel)
                      ?.sizeBytes
                  }
                  onDownloaded={() => status.refresh()}
                />
              }
            />
          ) : null}
          <Collapsible open={commandsOpen} onOpenChange={setCommandsOpen}>
            <SettingsRow
              {...searchableSetting("voice-dictation-commands")}
              description="Phrases that act instead of being typed, when they end a sentence."
              control={
                <CollapsibleTrigger
                  render={
                    <Button size="xs" variant="outline">
                      {commandsOpen ? "Done" : "Customize"}
                    </Button>
                  }
                />
              }
            />
            <CollapsiblePanel>
              <div className="space-y-1 pt-1">
                {VOICE_COMMAND_ACTIONS.map(({ action, label }) => (
                  <SettingsRow
                    key={action}
                    title={label}
                    control={
                      <div className="flex w-full items-center gap-2 sm:w-auto">
                        <DraftInput
                          className="min-w-0 flex-1 sm:w-56"
                          value={phrasesOf(voiceCommands, action)}
                          onCommit={(next) =>
                            updateSettings({
                              voiceDictationCommands: withPhrases(voiceCommands, action, next),
                            })
                          }
                          placeholder="phrase, another phrase"
                          aria-label={`${label} voice phrases`}
                        />
                        <Select
                          value={delayOf(voiceCommands, action) > 0 ? "debounced" : "immediate"}
                          onValueChange={(value) =>
                            updateSettings({
                              voiceDictationCommands: withDelay(
                                voiceCommands,
                                action,
                                value === "debounced" ? VOICE_COMMAND_DEBOUNCE_MS : 0,
                              ),
                            })
                          }
                        >
                          <SelectTrigger
                            className="w-28 shrink-0"
                            aria-label={`${label} command timing`}
                          >
                            <SelectValue>
                              {delayOf(voiceCommands, action) > 0 ? "Countdown" : "Immediate"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            <SelectItem hideIndicator value="immediate">
                              Immediate
                            </SelectItem>
                            <SelectItem hideIndicator value="debounced">
                              Countdown
                            </SelectItem>
                          </SelectPopup>
                        </Select>
                      </div>
                    }
                  />
                ))}
                {voiceCommands.map((command, index) =>
                  command.action !== "keybinding" ? null : (
                    <SettingsRow
                      key={command.id ?? `keybinding-${index}`}
                      title={command.keybinding ?? "App command"}
                      control={
                        <div className="flex w-full items-center gap-2 sm:w-auto">
                          <DraftInput
                            className="min-w-0 flex-1 sm:w-56"
                            value={command.phrases.join(", ")}
                            onCommit={(next) =>
                              updateSettings({
                                voiceDictationCommands: withCommandAt(voiceCommands, index, {
                                  phrases: parsePhrases(next),
                                }),
                              })
                            }
                            placeholder="phrase, another phrase"
                            aria-label={`${command.keybinding ?? "App command"} voice phrases`}
                          />
                          <Select
                            value={command.delayMs > 0 ? "debounced" : "immediate"}
                            onValueChange={(value) =>
                              updateSettings({
                                voiceDictationCommands: withCommandAt(voiceCommands, index, {
                                  delayMs: value === "debounced" ? VOICE_COMMAND_DEBOUNCE_MS : 0,
                                }),
                              })
                            }
                          >
                            <SelectTrigger
                              className="w-28 shrink-0"
                              aria-label={`${command.keybinding ?? "App command"} timing`}
                            >
                              <SelectValue>
                                {command.delayMs > 0 ? "Countdown" : "Immediate"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup align="end" alignItemWithTrigger={false}>
                              <SelectItem hideIndicator value="immediate">
                                Immediate
                              </SelectItem>
                              <SelectItem hideIndicator value="debounced">
                                Countdown
                              </SelectItem>
                            </SelectPopup>
                          </Select>
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Remove app command"
                            onClick={() =>
                              updateSettings({
                                voiceDictationCommands: withoutCommandAt(voiceCommands, index),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      }
                    />
                  ),
                )}
                {voiceCommands.length < MAX_VOICE_COMMANDS_COUNT ? (
                  <div className="px-3 pt-1 sm:px-4">
                    <Select
                      value=""
                      onValueChange={(value) =>
                        updateSettings({
                          voiceDictationCommands: [
                            ...voiceCommands,
                            {
                              action: "keybinding",
                              phrases: [],
                              keybinding: value as KeybindingCommand,
                              delayMs: VOICE_COMMAND_DEBOUNCE_MS,
                              id: randomUUID(),
                            },
                          ],
                        })
                      }
                    >
                      <SelectTrigger className="w-56" aria-label="Add an app command">
                        <SelectValue placeholder="Add app command…" />
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        {STATIC_KEYBINDING_COMMANDS.map((keybinding) => (
                          <SelectItem hideIndicator key={keybinding} value={keybinding}>
                            {keybinding}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                ) : null}
                {voiceCommands.map((command, index) =>
                  command.action !== "insert" ? null : (
                    <SettingsRow
                      key={command.id ?? `replacement-${index}`}
                      title={command.label ?? "Replacement"}
                      control={
                        <div className="flex w-full items-center gap-2 sm:w-auto">
                          <DraftInput
                            className="min-w-0 flex-1 sm:w-40"
                            value={command.phrases.join(", ")}
                            onCommit={(next) =>
                              updateSettings({
                                voiceDictationCommands: withCommandAt(voiceCommands, index, {
                                  phrases: parsePhrases(next),
                                }),
                              })
                            }
                            placeholder="say this"
                            aria-label="Replacement phrases"
                          />
                          <DraftInput
                            className="min-w-0 flex-1 sm:w-48"
                            value={command.text ?? ""}
                            onCommit={(next) =>
                              updateSettings({
                                voiceDictationCommands: withCommandAt(voiceCommands, index, {
                                  text: next,
                                }),
                              })
                            }
                            placeholder="types this"
                            aria-label="Replacement text"
                          />
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Remove replacement"
                            onClick={() =>
                              updateSettings({
                                voiceDictationCommands: withoutCommandAt(voiceCommands, index),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      }
                    />
                  ),
                )}
                {voiceCommands.length < MAX_VOICE_COMMANDS_COUNT ? (
                  <div className="px-3 pt-1 sm:px-4">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        updateSettings({
                          voiceDictationCommands: [
                            ...voiceCommands,
                            {
                              action: "insert",
                              phrases: [],
                              text: "",
                              delayMs: 0,
                              id: randomUUID(),
                            },
                          ],
                        })
                      }
                    >
                      Add replacement
                    </Button>
                  </div>
                ) : null}
                <p className="px-3 pt-1 text-xs text-muted-foreground sm:px-4">
                  Separate alternatives with commas; clear a field to disable that command. A
                  replacement types its text instead of the words you said. Countdown commands stay
                  visible in the draft for a moment first, so continuing to speak takes them back.
                  {commandsAreCustomized ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground"
                        onClick={() =>
                          updateSettings({ voiceDictationCommands: [...DEFAULT_VOICE_COMMANDS] })
                        }
                      >
                        Restore defaults
                      </button>
                    </>
                  ) : null}
                </p>
              </div>
            </CollapsiblePanel>
          </Collapsible>
          <SettingsRow
            {...searchableSetting("voice-dictation-language")}
            description="Language hint for the recognizer. The bundled models are English-only; leave empty unless a future multilingual model is selected."
            control={
              <DraftInput
                className="w-full sm:w-40"
                value={settings.voiceDictationLanguage}
                onCommit={(next) => updateSettings({ voiceDictationLanguage: next.trim() })}
                placeholder="en"
                aria-label="Voice dictation language"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
