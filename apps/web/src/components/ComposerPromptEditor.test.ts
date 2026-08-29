import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  HISTORIC_TAG,
  HISTORY_PUSH_TAG,
  PASTE_COMMAND,
} from "lexical";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { DEFAULT_VOICE_COMMANDS } from "@t3tools/contracts";
import {
  applyVoiceTranscript,
  resolveVoiceCommand,
  voiceDraftStateAt,
  type VoiceDraftEdit,
} from "@t3tools/client-runtime/voice";

import { registerComposerInlineTokenPaste } from "./composerInlineTokenPaste";

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

describe("registerComposerInlineTokenPaste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a copied mention without also running the plain-text paste fallback", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[improve-deploy-error-logging.md](.changeset/improve-deploy-error-logging.md)";
    const plainTextFallback = vi.fn(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(mention);
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:.changeset/improve-deploy-error-logging.md> ",
    );
  });

  it.each([
    "yarn expo install @expo/ui",
    "npm install @jane/foo.js",
    "import '@scope/pkg/sub/path'",
  ])("leaves scoped package command %s to the plain-text paste fallback", (command) => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn((event: ClipboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(event.clipboardData?.getData("text/plain") ?? "");
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(command);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).toHaveBeenCalledOnce();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(command);
  });

  it("pastes a canonical scoped folder link as a mention", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[sub](@scope/pkg/sub)";
    const plainTextFallback = vi.fn(() => true);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:@scope/pkg/sub> ",
    );
  });
});

describe("voice dictation history", () => {
  const writePrompt = (editor: ReturnType<typeof createEditor>, value: string, tag: string) => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        if (value.length > 0) paragraph.append($createTextNode(value));
        root.append(paragraph);
      },
      { tag, discrete: true },
    );
  };

  /** A composer wired the way `ComposerPromptEditor` wires its history. */
  const withHistory = () => {
    const editor = createEditor();
    const historyState = createEmptyHistoryState();
    registerHistory(editor, historyState, 300);
    writePrompt(editor, "", HISTORIC_TAG);
    // `anchorHistory`: a push records whatever the history sits on, so without
    // a starting point the first one records nothing.
    historyState.current = { editor, editorState: editor.getEditorState() };
    return {
      editor,
      historyState,
      /** `pushHistory`: the step an utterance cannot record by tagging. */
      record: () => {
        const current = historyState.current;
        if (current === null) return;
        historyState.undoStack.push({ ...current });
        historyState.redoStack.length = 0;
        historyState.current = { editor, editorState: editor.getEditorState() };
      },
      undoTargets: () =>
        historyState.undoStack.map((entry) =>
          entry.editorState.read(() => $getRoot().getTextContent()),
        ),
    };
  };

  it("records one step per utterance, even when the final repeats the last partial", () => {
    const composer = withHistory();

    // Whisper revises its own words as it listens; those are not undo steps.
    writePrompt(composer.editor, "ship", HISTORIC_TAG);
    writePrompt(composer.editor, "ship the fix", HISTORIC_TAG);
    expect(composer.historyState.undoStack).toHaveLength(0);

    // The final transcript usually repeats the last partial verbatim, so this
    // write changes nothing and no tag can carry the step.
    writePrompt(composer.editor, "ship the fix", HISTORIC_TAG);
    composer.record();

    // The step restores the draft as it was before the utterance began.
    expect(composer.undoTargets()).toEqual([""]);
  });

  it("leaves no step behind for the utterance that spoke a command", () => {
    const composer = withHistory();
    writePrompt(composer.editor, "ship the fix", HISTORIC_TAG);
    composer.record();

    // The phrase is typed into the draft and stripped again, and records
    // nothing; a step for it would cancel itself out, so undo would appear to
    // do nothing at all.
    writePrompt(composer.editor, "ship the fix undo that", HISTORIC_TAG);
    writePrompt(composer.editor, "ship the fix", HISTORIC_TAG);

    expect(composer.undoTargets()).toEqual([""]);
  });

  it("stacks a step per utterance so each undo walks back one", () => {
    const composer = withHistory();
    for (const draft of ["one", "one two", "one two three"]) {
      writePrompt(composer.editor, draft, HISTORIC_TAG);
      composer.record();
    }
    expect(composer.undoTargets()).toEqual(["", "one", "one two"]);
  });

  /**
   * The same wiring, driven by the real draft logic rather than hand-written
   * writes: every reply goes through `applyVoiceTranscript`, commands through
   * `resolveVoiceCommand`, and the editor is written with whatever they ask
   * for. Only React's scheduling and the DOM are left out.
   */
  it("builds the right undo stack from real transcripts and commands", () => {
    const composer = withHistory();
    const tags = { push: HISTORY_PUSH_TAG, historic: HISTORIC_TAG } as const;
    let state = voiceDraftStateAt(0);
    let prompt = "";
    const applyEdits = (text: string, edits: ReadonlyArray<VoiceDraftEdit>) =>
      edits.reduce(
        (current, edit) => `${current.slice(0, edit.start)}${edit.text}${current.slice(edit.end)}`,
        text,
      );

    const say = (transcript: string, isFinal: boolean, utteranceId: number) => {
      const heard = applyVoiceTranscript(state, {
        prompt,
        transcript,
        isFinal,
        utteranceId,
        commands: DEFAULT_VOICE_COMMANDS,
      });
      prompt = applyEdits(prompt, heard.edits);
      writePrompt(composer.editor, prompt, tags[heard.history]);
      state = heard.state;
      if (heard.completed) composer.record();
      if (state.pending === null) return null;

      const fired = resolveVoiceCommand(state, prompt);
      prompt = applyEdits(prompt, fired.edits);
      writePrompt(composer.editor, prompt, tags[fired.history]);
      state = fired.state;
      return fired.action;
    };

    say("ship", false, 1);
    say("ship the fix", false, 1);
    // Whisper's final repeating its last partial is the case that recorded
    // nothing at all before, leaving undo with an empty stack.
    say("ship the fix", true, 1);
    expect(prompt).toBe("ship the fix");
    expect(composer.undoTargets()).toEqual([""]);

    expect(say("undo that", true, 2)).toBe("undo");
    // The command stripped its own phrase and added no step of its own, so the
    // step waiting for undo is still the one that restores the empty draft.
    expect(prompt).toBe("ship the fix");
    expect(composer.undoTargets()).toEqual([""]);
  });
});
