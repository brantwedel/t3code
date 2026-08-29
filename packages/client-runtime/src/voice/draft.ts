import type {
  KeybindingCommand,
  VoiceCommandAction,
  VoiceCommandSetting,
} from "@t3tools/contracts";

import { matchTrailingVoiceCommand } from "./commands.ts";

/** The span of draft text the in-flight utterance owns. */
export interface VoiceDraftSpan {
  readonly start: number;
  readonly text: string;
  readonly utteranceId: number;
}

/** A recognised command, shown as the words spoken, waiting out its grace. */
export interface VoicePendingVoiceCommand {
  readonly action: VoiceCommandAction;
  /** Draft offsets of the phrase, including the space that precedes it. */
  readonly start: number;
  readonly end: number;
  /** Zero acts at once; otherwise the phrase counts this down in place. */
  readonly delayMs: number;
  readonly insertText: string;
  /** Which app command a `keybinding` action runs. */
  readonly keybinding: KeybindingCommand | undefined;
}

export interface VoiceDraftState {
  readonly insertAt: number;
  readonly span: VoiceDraftSpan | null;
  readonly pending: VoicePendingVoiceCommand | null;
  /** Highest utterance already finished with. A session's transcript is
   *  cumulative, so a reply at or below this would re-insert all of it. */
  readonly sealedUtteranceId: number;
}

export interface VoiceDraftEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** What the range must still contain; undefined for a fresh insertion. */
  readonly expectedText: string | undefined;
}

export interface VoiceDraftResult {
  /** Applied in order; later offsets already account for earlier edits. */
  readonly edits: ReadonlyArray<VoiceDraftEdit>;
  readonly state: VoiceDraftState;
  readonly action: VoiceDraftAction | null;
  readonly history: VoiceDraftHistoryMode;
  /** The edits finished an utterance holding text, so it is one undo step. */
  readonly completed: boolean;
}

/**
 * What the composer does once the edits land. Everything else a command needs
 * is already expressed as edits and `insertAt`.
 */
export type VoiceDraftAction = Extract<
  VoiceCommandAction,
  | "send"
  | "stop"
  | "undo"
  | "redo"
  | "caretStart"
  | "caretEnd"
  | "caretPreviousLine"
  | "caretNextLine"
  | "keybinding"
>;

/** How edits join the composer's undo history; `historic` keeps them out. */
export type VoiceDraftHistoryMode = "push" | "historic";

export const initialVoiceDraftState: VoiceDraftState = {
  insertAt: 0,
  span: null,
  pending: null,
  sealedUtteranceId: 0,
};

export function voiceDraftStateAt(cursor: number, sealedUtteranceId = 0): VoiceDraftState {
  return {
    insertAt: Math.max(0, cursor),
    span: null,
    pending: null,
    sealedUtteranceId,
  };
}

/** Seal the open utterance so its replies become history, not a new insertion. */
export function abandonVoiceUtterance(state: VoiceDraftState, insertAt: number): VoiceDraftState {
  return {
    insertAt: Math.max(0, insertAt),
    span: null,
    pending: null,
    sealedUtteranceId: Math.max(state.sealedUtteranceId, state.span?.utteranceId ?? 0),
  };
}

/**
 * Fold one transcript into the draft. Whisper revises earlier words as it
 * listens, so a partial replaces the utterance's span wholesale rather than
 * appending; a final seals it and anchors the next just after.
 */
export function applyVoiceTranscript(
  state: VoiceDraftState,
  input: {
    readonly prompt: string;
    readonly transcript: string;
    readonly isFinal: boolean;
    readonly commands: ReadonlyArray<VoiceCommandSetting>;
    readonly utteranceId: number;
  },
): VoiceDraftResult {
  if (input.utteranceId <= state.sealedUtteranceId) {
    return { edits: [], state, action: null, history: "historic", completed: false };
  }
  const command = input.isFinal
    ? matchTrailingVoiceCommand(input.transcript, input.commands)
    : null;
  const span =
    state.span !== null && state.span.utteranceId === input.utteranceId ? state.span : null;

  // Silence between utterances still ticks; an empty transcript must leave a
  // counting-down command alone, since only speaking again takes it back.
  if (span === null && input.transcript.trim().length === 0) {
    return { edits: [], state, action: null, history: "historic", completed: false };
  }

  // A span from an earlier utterance is accepted text: begin after it.
  const abandoned = state.span !== null && span === null ? state.span : null;
  const anchor =
    abandoned === null
      ? state.insertAt
      : Math.max(state.insertAt, abandoned.start + abandoned.text.length);
  const start = span?.start ?? Math.min(anchor, input.prompt.length);
  const end = start + (span?.text.length ?? 0);
  // Dictation continues a sentence rather than colliding with it.
  const needsLeadingSpace = start > 0 && !/\s$/u.test(input.prompt.slice(0, start));
  const lead = needsLeadingSpace ? " " : "";

  // The phrase stays visible while its grace period runs.
  const kept = command === null ? input.transcript : command.text;
  const visible =
    command === null
      ? input.transcript
      : kept.length > 0
        ? `${kept} ${command.phrase}`
        : command.phrase;
  const text = visible.length === 0 ? "" : `${lead}${visible}`;

  // The phrase owns the space before it, so removing it leaves no gap.
  const phraseStart =
    command === null ? 0 : kept.length > 0 ? start + lead.length + kept.length : start;
  const phraseEnd = command === null ? 0 : start + text.length;

  return {
    edits: [{ start, end, text, expectedText: span?.text }],
    state: {
      insertAt: input.isFinal ? start + text.length : anchor,
      span: input.isFinal ? null : { start, text, utteranceId: input.utteranceId },
      sealedUtteranceId: input.isFinal ? input.utteranceId : state.sealedUtteranceId,
      pending:
        command === null
          ? null
          : {
              action: command.action,
              start: phraseStart,
              end: phraseEnd,
              delayMs: command.delayMs,
              insertText: command.insertText,
              keybinding: command.keybinding,
            },
    },
    action: null,
    // Never tagged: the final usually repeats the last partial, writing
    // nothing that could carry a tag. `completed` drives the step instead.
    history: "historic",
    completed: input.isFinal && command === null && text.length > 0,
  };
}

/** Actions the composer performs itself; the rest are fully described by edits. */
const COMPOSER_ACTIONS = new Set<VoiceCommandAction>([
  "send",
  "stop",
  "undo",
  "redo",
  "caretStart",
  "caretEnd",
  "caretPreviousLine",
  "caretNextLine",
  "keybinding",
]);

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…"]);

/**
 * The sentence containing `offset`, as [start, end). Takes the whitespace that
 * follows it so removing one closes the gap, and leaves the whitespace before
 * it alone since that belongs to the sentence in front.
 */
function sentenceBoundsAt(text: string, offset: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  // The caret trails the text while dictating, and sits in the gap between
  // sentences after one ends, so walk back to the last character that is
  // actually part of a sentence and work outwards from there.
  let anchor = Math.min(at, text.length - 1);
  while (anchor > 0 && (anchor >= text.length || /\s/u.test(text[anchor]!))) anchor -= 1;
  if (anchor < 0) return { start: 0, end: 0 };

  let start = 0;
  for (let index = anchor - 1; index >= 0; index -= 1) {
    if (SENTENCE_TERMINATORS.has(text[index]!)) {
      start = index + 1;
      break;
    }
  }
  let end = text.length;
  for (let index = anchor; index < text.length; index += 1) {
    if (SENTENCE_TERMINATORS.has(text[index]!)) {
      end = index + 1;
      break;
    }
  }
  // Take the whitespace after it so removing a sentence closes the gap; the
  // whitespace before belongs to the sentence in front.
  while (end < text.length && /\s/u.test(text[end]!)) end += 1;
  while (start < end && /\s/u.test(text[start]!)) start += 1;
  return { start, end };
}

/** The line containing `offset`, as [start, end) excluding its newline. */
function lineBoundsAt(text: string, offset: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  // `lastIndexOf` clamps a negative start to 0 and would find a leading
  // newline as the end of a line before this one, putting start past end.
  const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
  const newline = text.indexOf("\n", at);
  return { start, end: newline === -1 ? text.length : newline };
}

/** Fire the pending command: remove its phrase, apply the edit it implies,
 *  and report the action the composer performs. */
export function resolveVoiceCommand(state: VoiceDraftState, prompt: string): VoiceDraftResult {
  const pending = state.pending;
  if (pending === null) {
    return { edits: [], state, action: null, history: "historic", completed: false };
  }
  const start = Math.min(pending.start, prompt.length);
  const end = Math.min(pending.end, prompt.length);
  const edits: VoiceDraftEdit[] = [{ start, end, text: "", expectedText: undefined }];
  let insertAt = start;
  const cleaned = `${prompt.slice(0, start)}${prompt.slice(end)}`;

  if (pending.action === "clear") {
    edits.push({ start: 0, end: cleaned.length, text: "", expectedText: undefined });
    insertAt = 0;
  } else if (pending.action === "newLine") {
    edits.push({ start, end: start, text: "\n", expectedText: undefined });
    insertAt = start + 1;
  } else if (pending.action === "insert") {
    edits.push({ start, end: start, text: pending.insertText, expectedText: undefined });
    insertAt = start + pending.insertText.length;
  } else if (pending.action === "caretStart") {
    insertAt = 0;
  } else if (pending.action === "caretEnd") {
    insertAt = cleaned.length;
  } else if (pending.action === "caretPreviousLine") {
    const line = lineBoundsAt(cleaned, start);
    insertAt = line.start === 0 ? 0 : lineBoundsAt(cleaned, line.start - 1).start;
  } else if (pending.action === "caretNextLine") {
    const line = lineBoundsAt(cleaned, start);
    insertAt = line.end === cleaned.length ? cleaned.length : line.end + 1;
  } else if (pending.action === "deleteSentence" || pending.action === "deleteLastSentence") {
    // "Last" always means the end of the draft; plain "sentence" means the one
    // the caret sits in, which during dictation is usually the same.
    const at = pending.action === "deleteLastSentence" ? cleaned.trimEnd().length : start;
    const sentence = sentenceBoundsAt(cleaned, at);
    if (sentence.end > sentence.start) {
      edits.push({ start: sentence.start, end: sentence.end, text: "", expectedText: undefined });
      insertAt = sentence.start;
    }
  } else if (pending.action === "deleteLine") {
    const line = lineBoundsAt(cleaned, start);
    // Take the newline with the line so the draft loses a row rather than
    // keeping a blank one; on the last line take the one before it instead.
    const from = line.end === cleaned.length && line.start > 0 ? line.start - 1 : line.start;
    const to = line.end === cleaned.length ? line.end : line.end + 1;
    edits.push({ start: from, end: to, text: "", expectedText: undefined });
    insertAt = from;
  }

  return {
    edits,
    state: {
      insertAt,
      span: null,
      pending: null,
      sealedUtteranceId: state.sealedUtteranceId,
    },
    action: COMPOSER_ACTIONS.has(pending.action) ? (pending.action as VoiceDraftAction) : null,
    history:
      pending.action === "clear" ||
      pending.action === "newLine" ||
      pending.action === "insert" ||
      pending.action === "deleteLine" ||
      pending.action === "deleteSentence" ||
      pending.action === "deleteLastSentence"
        ? "push"
        : "historic",
    completed: false,
  };
}

/** Keep the spoken words as ordinary text; the user talked past the command. */
export function cancelVoiceCommand(state: VoiceDraftState): VoiceDraftState {
  return state.pending === null ? state : { ...state, pending: null };
}

/** Highlight range for the in-flight span, or null when nothing is provisional. */
export function voiceProvisionalRange(
  state: VoiceDraftState,
): { readonly start: number; readonly end: number } | null {
  if (state.span === null || state.span.text.length === 0) return null;
  return { start: state.span.start, end: state.span.start + state.span.text.length };
}
