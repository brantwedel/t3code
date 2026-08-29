import type {
  KeybindingCommand,
  VoiceCommandAction,
  VoiceCommandSetting,
} from "@t3tools/contracts";

export interface VoiceCommandMatch {
  readonly action: VoiceCommandAction;
  /** The utterance with the command phrase (and its punctuation) stripped. */
  readonly text: string;
  /** The spoken phrase itself, as heard, so it can be shown before it fires. */
  readonly phrase: string;
  /** Grace period configured for this command; zero acts at once. */
  readonly delayMs: number;
  /** What an `insert` command types; empty for every other action. */
  readonly insertText: string;
  /** Which app command a `keybinding` action runs; unset for the rest. */
  readonly keybinding: KeybindingCommand | undefined;
}

/**
 * Treated like whitespace on both sides of the comparison. Whisper drops these
 * in and out of otherwise identical speech, so "clear a message" fires a
 * "clear message" command, and "clear message" fires one written with the
 * article. They still count as spoken words when the phrase is cut out.
 */
const FILLER_WORDS = new Set(["a", "an", "the"]);

/**
 * Words said as one or as two, interchangeably. Collapsed on both sides, so
 * "go to start" and "goto start" are the same phrase however either was
 * written or heard. Hyphenated forms need no entry: `normalizeWord` joins
 * them, which lands on the same canonical word.
 */
const COMPOUND_WORDS = new Map([
  ["go to", "goto"],
  ["new line", "newline"],
]);

/**
 * Different spellings of the same spoken word, which whisper picks between by
 * ear. Only ever spellings — a synonym belongs in the command's phrases, where
 * the user chose it, not silently here.
 */
const WORD_ALIASES = new Map([
  ["okay", "ok"],
  ["grey", "gray"],
  ["cancelled", "canceled"],
  ["colour", "color"],
  ["favourite", "favorite"],
]);

/** A word to compare, and how many spoken words it stands for. */
interface VoiceToken {
  readonly word: string;
  readonly spokenCount: number;
}

/**
 * Lowercase, without trailing punctuation, and with hyphens and apostrophes
 * joined away — so "go-to" reaches the same word as "goto", and "don't" the
 * same as "dont", whichever whisper produced.
 */
function normalizeWord(word: string): string {
  const bare = word
    .toLowerCase()
    .replace(/[.,!?;:…]+$/u, "")
    .replace(/[-'’]/gu, "");
  return WORD_ALIASES.get(bare) ?? bare;
}

/** Split into comparable tokens, collapsing compounds and dropping fillers. */
function tokenize(text: string): VoiceToken[] {
  const words = text
    .trim()
    .split(/\s+/u)
    .map(normalizeWord)
    .filter((word) => word.length > 0);
  const tokens: VoiceToken[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const next = words[index + 1];
    const compound = next === undefined ? undefined : COMPOUND_WORDS.get(`${words[index]} ${next}`);
    if (compound !== undefined) {
      tokens.push({ word: compound, spokenCount: 2 });
      index += 1;
      continue;
    }
    tokens.push({ word: words[index]!, spokenCount: 1 });
  }
  return tokens;
}

/**
 * How many spoken words the phrase consumes at the end of the utterance, or
 * null when it does not end there. Counted as spoken so the caller can split
 * the original text even where tokens collapsed or fillers were skipped.
 */
function trailingMatchLength(
  spoken: ReadonlyArray<VoiceToken>,
  phrase: ReadonlyArray<VoiceToken>,
): number | null {
  let index = spoken.length - 1;
  let consumed = 0;
  for (let position = phrase.length - 1; position >= 0; position -= 1) {
    const wanted = phrase[position]!.word;
    while (index >= 0 && spoken[index]!.word !== wanted && FILLER_WORDS.has(spoken[index]!.word)) {
      consumed += spoken[index]!.spokenCount;
      index -= 1;
    }
    if (index < 0 || spoken[index]!.word !== wanted) return null;
    consumed += spoken[index]!.spokenCount;
    index -= 1;
  }
  return consumed;
}

/**
 * Match a command phrase at the END of a finalized utterance — "open the
 * config file and send it" strips to "open the config file" and fires send.
 * Longest phrase wins so "send message" beats a hypothetical "send".
 */
export function matchTrailingVoiceCommand(
  text: string,
  commands: ReadonlyArray<VoiceCommandSetting>,
): VoiceCommandMatch | null {
  // Split the same way `tokenize` does, or a word that is only punctuation
  // counts here but not there and the phrase is cut one word off.
  const words = text
    .trim()
    .split(/\s+/u)
    .filter((word) => normalizeWord(word).length > 0);
  if (words.length === 0) return null;
  const spoken = tokenize(text);

  let best: {
    readonly action: VoiceCommandAction;
    /** Words of the utterance the phrase took, fillers included. */
    readonly wordCount: number;
    /** Tokens the phrase itself asks for; the more specific phrase wins. */
    readonly phraseLength: number;
    readonly delayMs: number;
    readonly insertText: string;
    readonly keybinding: KeybindingCommand | undefined;
  } | null = null;
  for (const command of commands) {
    for (const phrase of command.phrases) {
      const phraseTokens = tokenize(phrase).filter((token) => !FILLER_WORDS.has(token.word));
      if (phraseTokens.length === 0 || phraseTokens.length > spoken.length) continue;
      const wordCount = trailingMatchLength(spoken, phraseTokens);
      if (wordCount === null) continue;
      if (best === null || phraseTokens.length > best.phraseLength) {
        best = {
          action: command.action,
          wordCount,
          phraseLength: phraseTokens.length,
          delayMs: command.delayMs,
          insertText: command.text ?? "",
          keybinding: command.keybinding,
        };
      }
    }
  }
  if (best === null) return null;
  const kept = words.slice(0, words.length - best.wordCount).join(" ");
  const phrase = words.slice(words.length - best.wordCount).join(" ");
  return {
    action: best.action,
    text: kept.replace(/[\s,;:]+$/u, ""),
    phrase,
    delayMs: best.delayMs,
    insertText: best.insertText,
    keybinding: best.keybinding,
  };
}
