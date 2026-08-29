import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { KeybindingCommand } from "./keybindings.ts";

// ── Voice dictation (local whisper) ────────────────────────────
//
// Client ↔ server RPC schemas for streaming dictation sessions, plus the
// NDJSON protocol the server speaks to the `t3-whisper` sidecar — kept here
// for the same reason `resourceTelemetry.ts` owns the resource-monitor
// protocol: the Rust side mirrors these shapes field-for-field, and drift
// should surface as a schema failure, not a silent misparse.

export const WHISPER_SIDECAR_PROTOCOL_VERSION = 1 as const;

/** Whisper decodes at 16 kHz mono internally; clients resample before send. */
export const VOICE_TARGET_SAMPLE_RATE = 16_000 as const;

/** Rates a client may capture at; whisper decodes at 16 kHz regardless. */
export const VoiceSampleRate = PositiveInt.check(
  Schema.isBetween({ minimum: 8_000, maximum: 48_000 }),
);

export const VoiceModelId = Schema.Literals(["tiny.en", "base.en", "small.en"]);
export type VoiceModelId = typeof VoiceModelId.Type;
export const DEFAULT_VOICE_MODEL: VoiceModelId = "base.en";

/**
 * Built-in actions are literals so the composer's handling of each is checked
 * at compile time. `insert` is the open one: it carries its own `text`, which
 * is what a user-defined command needs to be more than a fixed vocabulary.
 */
export const VoiceCommandAction = Schema.Literals([
  "send",
  "clear",
  "stop",
  "newLine",
  "undo",
  "redo",
  "insert",
  "caretStart",
  "caretEnd",
  "caretPreviousLine",
  "caretNextLine",
  "deleteLine",
  "deleteSentence",
  "deleteLastSentence",
  "keybinding",
]);
export type VoiceCommandAction = typeof VoiceCommandAction.Type;

/** Grace period a debounced command counts down before it acts. */
export const VOICE_COMMAND_DEBOUNCE_MS = 1_500;

// The list is user-grown — the built-ins are seeded, and anyone can add their
// own replacements on top — so every dimension of it is bounded on the wire.
export const MAX_VOICE_COMMANDS_COUNT = 100;
export const MAX_VOICE_PHRASES_PER_COMMAND = 10;
export const MAX_VOICE_PHRASE_LENGTH = 100;
export const MAX_VOICE_INSERT_TEXT_LENGTH = 2_000;
export const MAX_VOICE_COMMAND_LABEL_LENGTH = 60;

export const VoiceCommandPhrase = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_VOICE_PHRASE_LENGTH),
);

/** Spoken phrases that trigger an action when they end an utterance. */
export const VoiceCommandSetting = Schema.Struct({
  action: VoiceCommandAction,
  /** Empty disables the command without forgetting the user configured it. */
  phrases: Schema.Array(VoiceCommandPhrase).check(
    Schema.isMaxLength(MAX_VOICE_PHRASES_PER_COMMAND),
  ),
  /**
   * What an `insert` command types into the draft; ignored by every other
   * action. A label distinguishes several inserts in settings, since they all
   * share one action.
   */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_VOICE_INSERT_TEXT_LENGTH))),
  label: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_VOICE_COMMAND_LABEL_LENGTH)),
  ),
  /**
   * Stable identity for user-created entries, which share the `insert` action
   * and so cannot be told apart by it. Built-ins are addressed by action and
   * leave this unset.
   */
  id: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /**
   * Which app command a `keybinding` action runs. Anything the keyboard can
   * reach is reachable by voice, so this is the same catalogue the shortcut
   * settings use rather than a second list that would drift from it.
   */
  keybinding: Schema.optional(KeybindingCommand),
  /**
   * Milliseconds the phrase stays visible in the draft, counting down, before
   * it acts — continuing to speak within the window takes it back. Zero acts
   * at once, which suits reversible commands.
   */
  delayMs: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type VoiceCommandSetting = typeof VoiceCommandSetting.Type;

/**
 * Phrases fire only when they END an utterance, so ordinary dictation is
 * unaffected. Defaults stay two words because a bare "send" or "clear" ends
 * a sentence often enough to misfire; shorten them in settings if you prefer.
 */
export const DEFAULT_VOICE_COMMANDS: ReadonlyArray<VoiceCommandSetting> = [
  // A command counts down when acting on a mishearing would cost something —
  // text removed, a message sent, the draft navigated away from. Moving the
  // caret, breaking a line and stopping the mic cost nothing and undo
  // themselves, so they act at once rather than making you wait every time.
  { action: "send", phrases: ["send message", "send it"], delayMs: VOICE_COMMAND_DEBOUNCE_MS },
  {
    action: "clear",
    phrases: ["clear message", "scratch that"],
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  { action: "stop", phrases: ["stop dictation", "stop listening"], delayMs: 0 },
  { action: "newLine", phrases: ["new line", "new paragraph"], delayMs: 0 },
  { action: "undo", phrases: ["undo that", "undo dictation"], delayMs: VOICE_COMMAND_DEBOUNCE_MS },
  { action: "redo", phrases: ["redo that"], delayMs: VOICE_COMMAND_DEBOUNCE_MS },
  { action: "caretStart", phrases: ["go to start", "goto start"], delayMs: 0 },
  { action: "caretEnd", phrases: ["go to end", "goto end"], delayMs: 0 },
  {
    action: "caretPreviousLine",
    phrases: ["go to previous line", "previous line"],
    delayMs: 0,
  },
  { action: "caretNextLine", phrases: ["go to next line", "next line"], delayMs: 0 },
  {
    action: "deleteLine",
    phrases: ["delete line", "clear line"],
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  {
    action: "deleteSentence",
    phrases: ["delete sentence", "clear sentence"],
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  {
    action: "deleteLastSentence",
    phrases: ["delete last sentence", "clear last sentence"],
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  // Moving between threads without touching the keyboard is what voice buys
  // you here; any other keybinding can be added in settings.
  {
    action: "keybinding",
    phrases: ["next chat", "next thread"],
    keybinding: "thread.next",
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  {
    action: "keybinding",
    phrases: ["previous chat", "previous thread"],
    keybinding: "thread.previous",
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  {
    action: "keybinding",
    phrases: ["new chat", "new thread"],
    keybinding: "chat.new",
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
  {
    action: "keybinding",
    phrases: ["open command palette"],
    keybinding: "commandPalette.toggle",
    delayMs: VOICE_COMMAND_DEBOUNCE_MS,
  },
];

/**
 * Actions the settings screen shows as a list the user owns rather than as a
 * fixed row: every app command shares `keybinding` and every replacement
 * shares `insert`, so those rows are addressed by position, not by action.
 */
const USER_LISTED_VOICE_ACTIONS: ReadonlySet<VoiceCommandAction> = new Set([
  "keybinding",
  "insert",
]);

/**
 * Fill in built-in commands the stored settings predate. Saved settings are
 * used verbatim, so without this a command added after someone customised
 * their phrases would never fire for them. An action they disabled keeps its
 * empty phrase list and stays disabled.
 *
 * Only the fixed rows are filled in. The seeded app commands and replacements
 * are the user's list from the moment they first save it: a missing row there
 * is one they deleted far more often than one their settings predate, and
 * putting a deleted row back is the worse of the two mistakes.
 */
export function withMissingVoiceCommands(
  commands: ReadonlyArray<VoiceCommandSetting>,
): ReadonlyArray<VoiceCommandSetting> {
  const present = new Set(commands.map((command) => command.action));
  const missing = DEFAULT_VOICE_COMMANDS.filter(
    (command) => !present.has(command.action) && !USER_LISTED_VOICE_ACTIONS.has(command.action),
  );
  return missing.length === 0 ? commands : [...commands, ...missing];
}

/**
 * Whisper takes an ISO 639-1 code and rejects anything else, failing every
 * append rather than the setting. Normalised at the boundary so an unusable
 * value falls back to its own detection instead of transcribing nothing —
 * settings saved before this existed keep working.
 */
export function normalizeVoiceLanguage(value: string | undefined): string | undefined {
  const code = value?.trim().toLowerCase();
  return code !== undefined && /^[a-z]{2}$/u.test(code) ? code : undefined;
}

export const VoiceSessionId = TrimmedNonEmptyString.pipe(Schema.brand("VoiceSessionId"));
export type VoiceSessionId = typeof VoiceSessionId.Type;

export const VoiceModelState = Schema.Literals(["not-downloaded", "downloading", "ready"]);
export type VoiceModelState = typeof VoiceModelState.Type;

export const VoiceModelStatus = Schema.Struct({
  id: VoiceModelId,
  state: VoiceModelState,
  sizeBytes: NonNegativeInt,
});
export type VoiceModelStatus = typeof VoiceModelStatus.Type;

export const VoiceSidecarStatus = Schema.Literals([
  "stopped",
  "starting",
  "healthy",
  "degraded",
  "unavailable",
]);
export type VoiceSidecarStatus = typeof VoiceSidecarStatus.Type;

export const VoiceStatus = Schema.Struct({
  /** False when no sidecar binary exists for this platform/architecture. */
  supported: Schema.Boolean,
  sidecar: VoiceSidecarStatus,
  /** Inference backends reported by the sidecar handshake; empty while stopped. */
  backends: Schema.Array(Schema.String),
  models: Schema.Array(VoiceModelStatus),
  activeSessions: NonNegativeInt,
});
export type VoiceStatus = typeof VoiceStatus.Type;

/**
 * base64 of int16 little-endian mono PCM at the session's sample rate.
 * The length cap bounds one append at ~20 s of 16 kHz audio — far above the
 * tick size a healthy client sends, low enough that a misbehaving client
 * cannot push megabytes per message through the socket.
 */
export const MAX_VOICE_PCM_CHUNK_CHARS = 900_000;
export const VoicePcmChunk = Schema.String.check(
  Schema.isBase64(),
  Schema.isMaxLength(MAX_VOICE_PCM_CHUNK_CHARS),
);
export type VoicePcmChunk = typeof VoicePcmChunk.Type;

export const VoiceSegment = Schema.Struct({
  text: Schema.String,
  t0Ms: NonNegativeInt,
  t1Ms: NonNegativeInt,
});
export type VoiceSegment = typeof VoiceSegment.Type;

export const VoiceTranscript = Schema.Struct({
  /**
   * Full text of the utterance so far (sealed prefix + live window). The
   * sidecar revises earlier words as context grows, so clients REPLACE the
   * dictated span with this text on every reply — never append.
   */
  text: Schema.String,
  segments: Schema.Array(VoiceSegment),
  /** True only on the reply to an append with `final: true`. */
  isFinal: Schema.Boolean,
});
export type VoiceTranscript = typeof VoiceTranscript.Type;

export const VoiceSessionStartInput = Schema.Struct({
  model: VoiceModelId,
  sampleRate: VoiceSampleRate,
  language: Schema.optionalKey(TrimmedNonEmptyString),
  /** Vocabulary bias fed to whisper's initial prompt (project name, branch). */
  prompt: Schema.optionalKey(TrimmedString),
});
export type VoiceSessionStartInput = typeof VoiceSessionStartInput.Type;

export const VoiceSessionStartResult = Schema.Struct({
  sessionId: VoiceSessionId,
});
export type VoiceSessionStartResult = typeof VoiceSessionStartResult.Type;

export const VoiceSessionAppendInput = Schema.Struct({
  sessionId: VoiceSessionId,
  pcm: VoicePcmChunk,
  /**
   * Byte cursor over everything the client has produced for this session.
   * The server drops any prefix it already accepted, so a retried append is
   * idempotent; a cursor past the accepted count is a client bug and fails.
   */
  offsetBytes: NonNegativeInt,
  final: Schema.Boolean,
});
export type VoiceSessionAppendInput = typeof VoiceSessionAppendInput.Type;

export const VoiceSessionCloseInput = Schema.Struct({
  sessionId: VoiceSessionId,
});
export type VoiceSessionCloseInput = typeof VoiceSessionCloseInput.Type;

export const VoiceModelDownloadInput = Schema.Struct({
  model: VoiceModelId,
});
export type VoiceModelDownloadInput = typeof VoiceModelDownloadInput.Type;

export const VoiceModelProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    model: VoiceModelId,
    receivedBytes: NonNegativeInt,
    totalBytes: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("verifying"),
    model: VoiceModelId,
  }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    model: VoiceModelId,
  }),
]);
export type VoiceModelProgressEvent = typeof VoiceModelProgressEvent.Type;

// ── Errors ─────────────────────────────────────────────────────

export class VoiceUnsupportedError extends Schema.TaggedErrorClass<VoiceUnsupportedError>()(
  "VoiceUnsupportedError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Voice dictation is unavailable on ${this.platform}/${this.architecture}: ${this.detail}`;
  }
}

export class VoiceModelNotReadyError extends Schema.TaggedErrorClass<VoiceModelNotReadyError>()(
  "VoiceModelNotReadyError",
  {
    model: VoiceModelId,
  },
) {
  override get message(): string {
    return `Voice model '${this.model}' is not downloaded. Download it in Settings before dictating.`;
  }
}

export class VoiceModelDownloadError extends Schema.TaggedErrorClass<VoiceModelDownloadError>()(
  "VoiceModelDownloadError",
  {
    model: VoiceModelId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Downloading voice model '${this.model}' failed: ${this.detail}`;
  }
}

export class VoiceSessionNotFoundError extends Schema.TaggedErrorClass<VoiceSessionNotFoundError>()(
  "VoiceSessionNotFoundError",
  {
    sessionId: VoiceSessionId,
  },
) {
  override get message(): string {
    return `Voice session '${this.sessionId}' does not exist or has expired.`;
  }
}

export class VoiceSessionBusyError extends Schema.TaggedErrorClass<VoiceSessionBusyError>()(
  "VoiceSessionBusyError",
  {
    sessionId: VoiceSessionId,
  },
) {
  override get message(): string {
    return `Voice session '${this.sessionId}' is still transcribing the previous audio.`;
  }
}

export class VoiceSessionCursorMismatchError extends Schema.TaggedErrorClass<VoiceSessionCursorMismatchError>()(
  "VoiceSessionCursorMismatchError",
  {
    sessionId: VoiceSessionId,
    acceptedBytes: NonNegativeInt,
    offsetBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Voice session '${this.sessionId}' received audio at offset ${this.offsetBytes} past the accepted ${this.acceptedBytes} bytes.`;
  }
}

export class VoiceTranscriptionFailedError extends Schema.TaggedErrorClass<VoiceTranscriptionFailedError>()(
  "VoiceTranscriptionFailedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Transcription failed: ${this.detail}`;
  }
}

// ── Whisper sidecar NDJSON protocol (server ↔ native/whisper) ──

export const WhisperSidecarLoadModelCommand = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("loadModel"),
  requestId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type WhisperSidecarLoadModelCommand = typeof WhisperSidecarLoadModelCommand.Type;

export const WhisperSidecarSessionStartCommand = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("sessionStart"),
  requestId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  // Same bound as the RPC: the sidecar scales its resample buffer by the ratio
  // to 16 kHz, so a tiny rate turns a small chunk into a huge allocation.
  sampleRate: VoiceSampleRate,
  language: Schema.optionalKey(TrimmedNonEmptyString),
  prompt: Schema.optionalKey(TrimmedString),
});
export type WhisperSidecarSessionStartCommand = typeof WhisperSidecarSessionStartCommand.Type;

export const WhisperSidecarSessionAppendCommand = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("sessionAppend"),
  requestId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  /** base64 int16 LE mono PCM at the session sample rate; may be empty. */
  pcm: Schema.String,
  /**
   * Byte position of this chunk within the utterance's PCM stream. The
   * sidecar drops any already-accepted prefix, so a chunk replayed after a
   * lost reply (a decode error or a client-side timeout) never appends the
   * same audio twice — the retry contract holds across the process boundary,
   * not just in the server's bookkeeping.
   */
  offsetBytes: NonNegativeInt,
  final: Schema.Boolean,
});
export type WhisperSidecarSessionAppendCommand = typeof WhisperSidecarSessionAppendCommand.Type;

export const WhisperSidecarSessionCloseCommand = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("sessionClose"),
  requestId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
});
export type WhisperSidecarSessionCloseCommand = typeof WhisperSidecarSessionCloseCommand.Type;

export const WhisperSidecarShutdownCommand = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("shutdown"),
});
export type WhisperSidecarShutdownCommand = typeof WhisperSidecarShutdownCommand.Type;

export const WhisperSidecarCommand = Schema.Union([
  WhisperSidecarLoadModelCommand,
  WhisperSidecarSessionStartCommand,
  WhisperSidecarSessionAppendCommand,
  WhisperSidecarSessionCloseCommand,
  WhisperSidecarShutdownCommand,
]);
export type WhisperSidecarCommand = typeof WhisperSidecarCommand.Type;

export const WhisperSidecarCapabilities = Schema.Struct({
  backends: Schema.Array(Schema.String),
  streaming: Schema.Boolean,
  sealing: Schema.Boolean,
});
export type WhisperSidecarCapabilities = typeof WhisperSidecarCapabilities.Type;

export const WhisperSidecarHelloEvent = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("hello"),
  sidecarVersion: Schema.String,
  sidecarPid: NonNegativeInt,
  platform: Schema.String,
  arch: Schema.String,
  capabilities: WhisperSidecarCapabilities,
});
export type WhisperSidecarHelloEvent = typeof WhisperSidecarHelloEvent.Type;

export const WhisperSidecarOkEvent = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("ok"),
  requestId: TrimmedNonEmptyString,
});
export type WhisperSidecarOkEvent = typeof WhisperSidecarOkEvent.Type;

export const WhisperSidecarTranscriptEvent = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("transcript"),
  requestId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  text: Schema.String,
  segments: Schema.Array(VoiceSegment),
  isFinal: Schema.Boolean,
});
export type WhisperSidecarTranscriptEvent = typeof WhisperSidecarTranscriptEvent.Type;

export const WhisperSidecarErrorEvent = Schema.Struct({
  version: Schema.Literal(WHISPER_SIDECAR_PROTOCOL_VERSION),
  type: Schema.Literal("error"),
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  code: Schema.String,
  message: Schema.String,
  /** True when only the addressed request failed and the process is still usable. */
  recoverable: Schema.Boolean,
});
export type WhisperSidecarErrorEvent = typeof WhisperSidecarErrorEvent.Type;

export const WhisperSidecarEvent = Schema.Union([
  WhisperSidecarHelloEvent,
  WhisperSidecarOkEvent,
  WhisperSidecarTranscriptEvent,
  WhisperSidecarErrorEvent,
]);
export type WhisperSidecarEvent = typeof WhisperSidecarEvent.Type;
