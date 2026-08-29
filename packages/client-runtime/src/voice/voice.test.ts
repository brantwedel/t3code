import { describe, expect, it } from "vite-plus/test";
import type { VoiceSessionId, VoiceTranscript } from "@t3tools/contracts";

import {
  VOICE_ATTACK_MS,
  VOICE_RELEASE_MS,
  VOICE_TICK_MS,
  VOICE_UTTERANCE_END_MS,
  VoicePcmRing,
  encodeVoicePcm,
  frameRmsLevel,
  initialVoiceVadState,
  resampleLinear,
  updateVoiceVad,
  voiceUtteranceEnded,
} from "./capture.ts";
import { matchTrailingVoiceCommand } from "./commands.ts";
import {
  applyVoiceTranscript,
  cancelVoiceCommand,
  resolveVoiceCommand,
  voiceDraftStateAt,
  voiceProvisionalRange,
  type VoiceDraftEdit,
} from "./draft.ts";
import { VoiceSessionDriver, type VoiceSessionTransport } from "./session.ts";

/** Feed the gate one level for a duration at the real ~33 ms frame cadence. */
const feedLevel = (
  state: ReturnType<typeof updateVoiceVad>,
  level: number,
  fromMs: number,
  durationMs: number,
) => {
  let current = state;
  let now = fromMs;
  const FRAME_MS = 33;
  for (; now <= fromMs + durationMs; now += FRAME_MS) {
    current = updateVoiceVad(current, level, now);
  }
  return { state: current, now };
};

describe("updateVoiceVad", () => {
  it("opens only after sustained loudness and closes after sustained quiet", () => {
    const opened = feedLevel(initialVoiceVadState, 0.5, 0, VOICE_ATTACK_MS + 100);
    expect(opened.state.speaking).toBe(true);

    // A single quiet frame does not close the gate…
    const dipped = updateVoiceVad(opened.state, 0, opened.now);
    expect(dipped.speaking).toBe(true);

    // …but sustained quiet does, once the smoothed level decays below the gate.
    const closed = feedLevel(dipped, 0, opened.now + 33, VOICE_RELEASE_MS + 1_500);
    expect(closed.state.speaking).toBe(false);
  });

  it("opens on speech that starts with the very first frame", () => {
    // Someone holding push-to-talk is already talking when the mic opens. At
    // a conversational level the old ramp out of zero took seven frames to
    // even reach the gate, and those frames held the first words.
    const speech = 0.06;
    const first = updateVoiceVad(initialVoiceVadState, speech, 0);
    expect(first.smoothedLevel).toBe(speech);
    expect(first.streakStartedAtMs).toBe(0);

    const opened = feedLevel(initialVoiceVadState, speech, 0, VOICE_ATTACK_MS + 33);
    expect(opened.state.speaking).toBe(true);
  });

  it("ends the utterance only after the silence grace period", () => {
    const opened = feedLevel(initialVoiceVadState, 0.5, 0, VOICE_ATTACK_MS + 100);
    const closed = feedLevel(opened.state, 0, opened.now, VOICE_RELEASE_MS + 1_500);
    expect(closed.state.speaking).toBe(false);
    const lastSpeechAt = closed.state.lastSpeechAtMs!;
    expect(voiceUtteranceEnded(closed.state, lastSpeechAt + VOICE_UTTERANCE_END_MS - 1)).toBe(
      false,
    );
    expect(voiceUtteranceEnded(closed.state, lastSpeechAt + VOICE_UTTERANCE_END_MS)).toBe(true);
  });
});

describe("VoicePcmRing", () => {
  it("reads from an absolute position across chunk boundaries", () => {
    const ring = new VoicePcmRing(16_000);
    ring.push(Float32Array.of(1, 2, 3));
    ring.push(Float32Array.of(4, 5));
    expect(Array.from(ring.readFromAbsolute(0))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(ring.readFromAbsolute(2))).toEqual([3, 4, 5]);
    expect(ring.absoluteSampleCount).toBe(5);
  });

  it("drops oldest audio past capacity while keeping the absolute axis", () => {
    const ring = new VoicePcmRing(1_000, 4);
    ring.push(Float32Array.of(1, 2, 3));
    ring.push(Float32Array.of(4, 5, 6));
    expect(ring.bufferedSampleCount).toBeLessThanOrEqual(4);
    expect(ring.absoluteSampleCount).toBe(6);
    // Reading from before the drop point silently starts at retained audio.
    expect(Array.from(ring.readFromAbsolute(0))).toEqual([4, 5, 6]);
  });
});

describe("encodeVoicePcm", () => {
  it("clamps and encodes int16 little-endian", () => {
    const { base64, byteLength } = encodeVoicePcm(Float32Array.of(0, 1, -1, 2));
    expect(byteLength).toBe(8);
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const ints = new Int16Array(bytes.buffer);
    expect(Array.from(ints)).toEqual([0, 32_767, -32_767, 32_767]);
  });
});

describe("resampleLinear", () => {
  it("halves the sample count from 32k to 16k", () => {
    const source = new Float32Array(64).fill(0.5);
    expect(resampleLinear(source, 32_000, 16_000).length).toBe(32);
  });
});

describe("frameRmsLevel", () => {
  it("computes rms", () => {
    expect(frameRmsLevel(Float32Array.of(0.5, -0.5))).toBeCloseTo(0.5);
    expect(frameRmsLevel(new Float32Array(0))).toBe(0);
  });
});

/**
 * Deterministic manual scheduler: no global timers, so tests advance virtual
 * time explicitly and flush the async tick work between steps.
 */
const makeManualScheduler = () => {
  let now = 0;
  let nextId = 1;
  const pending: Array<{ readonly at: number; readonly run: () => void; readonly id: number }> = [];
  const scheduler = {
    schedule: (run: () => void, delayMs: number) => {
      const id = nextId;
      nextId += 1;
      pending.push({ at: now + delayMs, run, id });
      return () => {
        const index = pending.findIndex((entry) => entry.id === id);
        if (index >= 0) pending.splice(index, 1);
      };
    },
  };
  const flushMicrotasks = async () => {
    for (let round = 0; round < 10; round += 1) {
      await Promise.resolve();
    }
  };
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const dueIndex = pending.findIndex((entry) => entry.at <= now);
      if (dueIndex < 0) break;
      const [due] = pending.splice(dueIndex, 1);
      due!.run();
      await flushMicrotasks();
    }
    await flushMicrotasks();
  };
  return { scheduler, advance };
};

const transcriptOf = (text: string, isFinal = false): VoiceTranscript => ({
  text,
  segments: [],
  isFinal,
});

describe("VoiceSessionDriver", () => {
  const sessionId = "vs-test" as VoiceSessionId;

  it("advances the byte cursor only on success and retries the same chunk", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const appends: Array<{ pcm: string; offsetBytes: number; final: boolean }> = [];
      let failNext = true;
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          appends.push({ pcm: input.pcm, offsetBytes: input.offsetBytes, final: input.final });
          if (failNext) {
            failNext = false;
            throw new Error("relay hiccup");
          }
          return transcriptOf("heard", input.final);
        },
        close: async () => undefined,
      };
      const transcripts: VoiceTranscript[] = [];
      const errors: unknown[] = [];
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: (transcript) => transcripts.push(transcript),
        onError: (error) => errors.push(error),
      });
      await driver.start();
      // One second of audio: comfortably past the min-tick threshold.
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();

      await advance(600);
      expect(appends).toHaveLength(1);
      expect(errors).toHaveLength(1);

      await advance(600);
      expect(appends).toHaveLength(2);
      // Identical retry: same bytes, same cursor.
      expect(appends[1]).toEqual(appends[0]);
      expect(transcripts).toHaveLength(1);

      // New audio after the retry continues from the advanced cursor.
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      await advance(600);
      expect(appends).toHaveLength(3);
      expect(appends[2]!.offsetBytes).toBe(32_000);

      driver.requestFinal();
      await advance(100);
      expect(appends.at(-1)!.final).toBe(true);
      expect(driver.isDone).toBe(true);
    }
  });

  it("never transcribes until the voice gate has heard speech", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const appends: string[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          appends.push(input.pcm);
          return transcriptOf("heard", input.final);
        },
        close: async () => undefined,
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();

      // Room noise and keystrokes for three seconds: whisper is never asked,
      // which is what stops it inventing speech over silence.
      for (let tick = 0; tick < 6; tick += 1) {
        driver.pushAudio(new Float32Array(8_000).fill(0.0005));
        driver.discardIdleAudio();
        await advance(600);
      }
      expect(appends).toEqual([]);

      // Speech opens the gate, and only the pre-roll before it survives.
      driver.pushAudio(new Float32Array(16_000).fill(0.2));
      driver.noteSpeech();
      await advance(600);
      expect(appends).toHaveLength(1);
      const sentSeconds = atob(appends[0]!).length / 2 / 16_000;
      expect(sentSeconds).toBeLessThan(1.6);
    }
  });

  it("sends an empty final flush when no fresh audio remains", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const appends: Array<{ pcm: string; final: boolean }> = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          appends.push({ pcm: input.pcm, final: input.final });
          return transcriptOf("done", input.final);
        },
        close: async () => undefined,
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      await advance(600);
      driver.requestFinal();
      await advance(100);
      expect(appends).toHaveLength(2);
      expect(appends[1]).toEqual({ pcm: "", final: true });
      expect(driver.isDone).toBe(true);
    }
  });

  it("drains a retried backlog before sending final, losing no audio", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const appends: Array<{ bytes: number; offsetBytes: number; final: boolean }> = [];
      let failNext = true;
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          appends.push({
            bytes: atob(input.pcm).length,
            offsetBytes: input.offsetBytes,
            final: input.final,
          });
          if (failNext) {
            failNext = false;
            throw new Error("relay hiccup");
          }
          return transcriptOf("heard", input.final);
        },
        close: async () => undefined,
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      await advance(600);
      expect(appends).toHaveLength(1);
      // The user keeps talking past the failed cut, then finalizes.
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      driver.requestFinal();
      await advance(100);
      // The stale chunk retried WITHOUT final; the fresh audio carried it.
      expect(appends).toHaveLength(3);
      expect(appends[1]!.final).toBe(false);
      expect(appends[2]).toMatchObject({ offsetBytes: 32_000, final: true });
      expect(driver.isDone).toBe(true);
    }
  });

  it("caps a single cut so a backlog drains as several appends", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const appends: Array<{ bytes: number; final: boolean }> = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          appends.push({ bytes: atob(input.pcm).length, final: input.final });
          return transcriptOf("heard", input.final);
        },
        close: async () => undefined,
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      // 25 seconds of audio arrives in one burst (recovered outage).
      driver.pushAudio(new Float32Array(16_000 * 25).fill(0.1));
      driver.noteSpeech();
      driver.requestFinal();
      await advance(100);
      // 10 s + 10 s + 5 s(final): every chunk under the wire cap.
      expect(appends.map((entry) => entry.bytes)).toEqual([320_000, 320_000, 160_000]);
      expect(appends.map((entry) => entry.final)).toEqual([false, false, true]);
      expect(driver.isDone).toBe(true);
    }
  });

  it("stops retrying on a terminal error and closes the session", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const closed: VoiceSessionId[] = [];
      const errors: unknown[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async () => {
          throw { _tag: "VoiceSessionNotFoundError" };
        },
        close: async (id) => {
          closed.push(id);
        },
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        isTerminalError: (error) => typeof error === "object" && error !== null && "_tag" in error,
        onTranscript: () => undefined,
        onError: (error) => errors.push(error),
      });
      await driver.start();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      await advance(600);
      await advance(600);
      expect(errors).toHaveLength(1);
      expect(closed).toEqual([sessionId]);
      expect(driver.isDone).toBe(true);
    }
  });

  it("gives up after bounded final retries instead of ticking forever", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      let attempts = 0;
      const closed: VoiceSessionId[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async () => {
          attempts += 1;
          throw new Error("network down");
        },
        close: async (id) => {
          closed.push(id);
        },
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      driver.requestFinal();
      for (let round = 0; round < 8; round += 1) {
        await advance(600);
      }
      expect(attempts).toBe(3);
      expect(closed).toEqual([sessionId]);
      expect(driver.isDone).toBe(true);
    }
  });

  it("retries a dropped connection across the resume window, then ends the utterance", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      let offline = true;
      const transcripts: VoiceTranscript[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          if (offline) throw new Error("connection lost");
          return transcriptOf("came back", input.final);
        },
        close: async () => undefined,
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: (transcript) => transcripts.push(transcript),
        onError: () => undefined,
      });
      await driver.start();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();

      // Two seconds down: still inside the window, so the utterance is intact
      // and the audio spoken through it is still waiting to go out.
      for (let round = 0; round < 4; round += 1) await advance(600);
      expect(driver.isDone).toBe(false);
      offline = false;
      await advance(600);
      expect(transcripts.map((transcript) => transcript.text)).toEqual(["came back"]);
    }

    {
      const { scheduler, advance } = makeManualScheduler();
      const closed: VoiceSessionId[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async () => {
          throw new Error("connection lost");
        },
        close: async (id) => {
          closed.push(id);
        },
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      // Past the window the server is not coming back to this session; the
      // caller is freed to open a fresh one rather than hold the mic open.
      for (let round = 0; round < 20; round += 1) await advance(600);
      expect(closed).toEqual([sessionId]);
      expect(driver.isDone).toBe(true);
    }
  });

  it("measures the utterance cap from speech, not from the mic opening", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const finals: boolean[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => {
          finals.push(input.final);
          return transcriptOf("still going", input.final);
        },
        close: async () => undefined,
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      // Half a minute of silence while the mic waited, then one second spoken.
      driver.pushAudio(new Float32Array(16_000 * 30));
      driver.discardIdleAudio();
      driver.noteSpeech();
      driver.pushAudio(new Float32Array(16_000).fill(0.1));

      await advance(600);
      expect(finals).toEqual([false]);
      expect(driver.isDone).toBe(false);
    }
  });

  it("cancel closes the session and stops ticking", async () => {
    {
      const { scheduler, advance } = makeManualScheduler();
      const closed: VoiceSessionId[] = [];
      const transport: VoiceSessionTransport = {
        start: async () => ({ sessionId }),
        append: async (input) => transcriptOf("x", input.final),
        close: async (id) => {
          closed.push(id);
        },
      };
      const driver = new VoiceSessionDriver({
        transport,
        scheduler,
        sourceSampleRate: 16_000,
        onTranscript: () => undefined,
        onError: () => undefined,
      });
      await driver.start();
      await driver.cancel();
      expect(closed).toEqual([sessionId]);
      driver.pushAudio(new Float32Array(16_000).fill(0.1));
      driver.noteSpeech();
      await advance(2_000);
      expect(driver.isDone).toBe(true);
    }
  });

  it("drops a reply that lands after the driver was cancelled", async () => {
    const { scheduler, advance } = makeManualScheduler();
    const heard: string[] = [];
    const errors: unknown[] = [];
    const pending: { release: ((transcript: VoiceTranscript) => void) | null } = { release: null };
    const transport: VoiceSessionTransport = {
      start: async () => ({ sessionId }),
      append: async () =>
        new Promise<VoiceTranscript>((resolve) => {
          pending.release = resolve;
        }),
      close: async () => undefined,
    };
    const driver = new VoiceSessionDriver({
      transport,
      scheduler,
      sourceSampleRate: 16_000,
      onTranscript: (transcript) => heard.push(transcript.text),
      onError: (error) => errors.push(error),
    });
    await driver.start();
    driver.pushAudio(new Float32Array(16_000).fill(0.1));
    driver.noteSpeech();
    await advance(VOICE_TICK_MS);
    expect(pending.release).not.toBeNull();

    // The user typed in the draft: this utterance is abandoned mid-request.
    await driver.cancel();
    pending.release?.(transcriptOf("words the user already moved past", false));
    await advance(VOICE_TICK_MS);

    expect(heard).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("matchTrailingVoiceCommand", () => {
  const commands = [
    { action: "send" as const, phrases: ["send message", "send it"], delayMs: 0 },
    { action: "clear" as const, phrases: ["clear message", "scratch that"], delayMs: 0 },
    { action: "newLine" as const, phrases: ["new line"], delayMs: 0 },
  ];

  it("matches hyphenated and alternate spellings of the same word", () => {
    // Hyphens join, landing on the same word as the compound form.
    expect(
      matchTrailingVoiceCommand("fix this go-to start", [
        { action: "caretStart" as const, phrases: ["go to start"], delayMs: 0 },
      ]),
    ).toMatchObject({ action: "caretStart", text: "fix this", phrase: "go-to start" });

    // Spellings of one spoken word are interchangeable; synonyms are not.
    const ok = [{ action: "send" as const, phrases: ["okay send"], delayMs: 0 }];
    expect(matchTrailingVoiceCommand("ship it ok send", ok)).toMatchObject({ action: "send" });
    expect(matchTrailingVoiceCommand("ship it sure send", ok)).toBeNull();
  });

  it("matches a compound word said as one word or two", () => {
    const goto = [{ action: "caretStart" as const, phrases: ["go to start"], delayMs: 0 }];
    // Written as two words, spoken as one.
    expect(matchTrailingVoiceCommand("fix this goto start", goto)).toMatchObject({
      action: "caretStart",
      text: "fix this",
      phrase: "goto start",
    });
    // And the reverse: written as one, spoken as two.
    expect(
      matchTrailingVoiceCommand("fix this go to start", [
        { action: "caretStart" as const, phrases: ["goto start"], delayMs: 0 },
      ]),
    ).toMatchObject({ text: "fix this", phrase: "go to start" });
  });

  it("treats filler words like whitespace on both sides", () => {
    // Whisper drops articles in and out of otherwise identical speech.
    expect(matchTrailingVoiceCommand("Ship the fix, clear a message", commands)).toMatchObject({
      action: "clear",
      text: "Ship the fix",
      phrase: "clear a message",
    });
    // And a phrase written with the article still fires without it.
    expect(
      matchTrailingVoiceCommand("Ship the fix, clear message", [
        { action: "clear" as const, phrases: ["clear the message"], delayMs: 0 },
      ]),
    ).toMatchObject({ action: "clear", phrase: "clear message" });
    // A filler inside the utterance body is untouched by the cut.
    expect(matchTrailingVoiceCommand("Read the docs send it", commands)).toMatchObject({
      text: "Read the docs",
      phrase: "send it",
    });
  });

  it("strips a trailing phrase, ignoring case and punctuation", () => {
    expect(matchTrailingVoiceCommand("Fix the login bug. Send it.", commands)).toMatchObject({
      action: "send",
      text: "Fix the login bug.",
      phrase: "Send it.",
    });
    expect(matchTrailingVoiceCommand("Scratch that", commands)).toMatchObject({
      action: "clear",
      text: "",
    });
  });

  it("ignores phrases in the middle of the utterance", () => {
    expect(
      matchTrailingVoiceCommand("please send it to the reviewer for comments", commands),
    ).toBeNull();
  });

  it("prefers the longest matching phrase and trims dangling separators", () => {
    const overlapping = [
      { action: "send" as const, phrases: ["it"], delayMs: 0 },
      { action: "clear" as const, phrases: ["send it"], delayMs: 0 },
    ];
    expect(matchTrailingVoiceCommand("do the thing, send it", overlapping)).toMatchObject({
      action: "clear",
      text: "do the thing",
    });
  });

  it("returns null for empty text or no configured phrases", () => {
    expect(matchTrailingVoiceCommand("   ", commands)).toBeNull();
    expect(matchTrailingVoiceCommand("hello", [])).toBeNull();
  });
});

/** Apply draft edits to a prompt the way the composer does, in order. */
const applyEdits = (prompt: string, edits: ReadonlyArray<VoiceDraftEdit>): string =>
  edits.reduce(
    (text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`,
    prompt,
  );

describe("applyVoiceTranscript", () => {
  const commands = [
    { action: "send" as const, phrases: ["send it"], delayMs: 1_500 },
    { action: "clear" as const, phrases: ["scratch that"], delayMs: 0 },
    { action: "newLine" as const, phrases: ["new line"], delayMs: 0 },
    { action: "stop" as const, phrases: ["stop dictation"], delayMs: 0 },
    { action: "undo" as const, phrases: ["undo that"], delayMs: 0 },
    { action: "redo" as const, phrases: ["redo that"], delayMs: 0 },
    {
      action: "insert" as const,
      phrases: ["code block"],
      delayMs: 0,
      text: "```\n\n```",
    },
  ];
  const base = { commands, isFinal: false, utteranceId: 1 };

  it("inserts at the anchor and rewrites the span in place", () => {
    const first = applyVoiceTranscript(voiceDraftStateAt(5), {
      ...base,
      prompt: "Fix: ",
      transcript: "the login",
    });
    expect(first.edits).toEqual([{ start: 5, end: 5, text: "the login", expectedText: undefined }]);
    expect(first.state.span).toEqual({ start: 5, text: "the login", utteranceId: 1 });

    // The revision replaces the whole span, guarded by what it wrote before.
    const second = applyVoiceTranscript(first.state, {
      ...base,
      prompt: "Fix: the login",
      transcript: "the login bug",
    });
    expect(second.edits).toEqual([
      { start: 5, end: 14, text: "the login bug", expectedText: "the login" },
    ]);
  });

  it("adds a separating space only when the anchor needs one", () => {
    const spaced = applyVoiceTranscript(voiceDraftStateAt(4), {
      ...base,
      prompt: "note",
      transcript: "hello",
    });
    expect(spaced.edits[0]!.text).toBe(" hello");
    const alreadySpaced = applyVoiceTranscript(voiceDraftStateAt(5), {
      ...base,
      prompt: "note ",
      transcript: "hello",
    });
    expect(alreadySpaced.edits[0]!.text).toBe("hello");
  });

  it("seals the span on final and anchors the next utterance after it", () => {
    const open = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      prompt: "",
      transcript: "hello",
    });
    const sealed = applyVoiceTranscript(open.state, {
      ...base,
      isFinal: true,
      prompt: "hello",
      transcript: "hello there",
    });
    expect(sealed.state.span).toBeNull();
    expect(sealed.state.insertAt).toBe("hello there".length);
  });

  it("keeps the command phrase in the draft until it is resolved", () => {
    const open = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      prompt: "",
      transcript: "ship the fix",
    });
    const heard = applyVoiceTranscript(open.state, {
      ...base,
      isFinal: true,
      prompt: "ship the fix",
      transcript: "ship the fix send it",
    });
    // The words that will act stay visible, marked for the countdown.
    expect(heard.edits).toEqual([
      { start: 0, end: 12, text: "ship the fix send it", expectedText: "ship the fix" },
    ]);
    expect(heard.state.pending).toEqual({
      action: "send",
      start: 12,
      end: 20,
      delayMs: 1_500,
      insertText: "",
      keybinding: undefined,
    });
    expect(heard.action).toBeNull();

    const fired = resolveVoiceCommand(heard.state, "ship the fix send it");
    expect(fired.edits).toEqual([{ start: 12, end: 20, text: "", expectedText: undefined }]);
    expect(fired.action).toBe("send");
    expect(fired.state.pending).toBeNull();
  });

  it("leaves a counting-down command alone while the mic hears only silence", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "ship it send it",
    });
    expect(heard.state.pending).not.toBeNull();
    // The next utterance ticks against silence before anyone speaks again;
    // those empty transcripts must not retract the command.
    for (const quiet of ["", "   ", "\n"]) {
      const idle = applyVoiceTranscript(heard.state, {
        ...base,
        prompt: "ship it send it",
        transcript: quiet,
      });
      expect(idle.edits).toEqual([]);
      expect(idle.state.pending).toEqual(heard.state.pending);
    }
  });

  it("keeps the phrase as plain text when the command is cancelled", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "ship it send it",
    });
    expect(heard.state.pending).not.toBeNull();
    expect(cancelVoiceCommand(heard.state).pending).toBeNull();
  });

  it("clears the whole draft once the clear command resolves", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(6), {
      ...base,
      isFinal: true,
      prompt: "keep: ",
      transcript: "draft scratch that",
    });
    const prompt = "keep: draft scratch that";
    const fired = resolveVoiceCommand(heard.state, prompt);
    // The phrase goes first, then everything that is left.
    expect(fired.edits[0]).toEqual({ start: 11, end: 24, text: "", expectedText: undefined });
    expect(fired.edits[1]).toEqual({ start: 0, end: 11, text: "", expectedText: undefined });
    expect(fired.state.insertAt).toBe(0);
    expect(fired.action).toBeNull();
  });

  it("breaks the line where the command was spoken", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "first new line",
    });
    const fired = resolveVoiceCommand(heard.state, "first new line");
    expect(fired.edits[0]).toEqual({ start: 5, end: 14, text: "", expectedText: undefined });
    expect(fired.edits[1]).toEqual({ start: 5, end: 5, text: "\n", expectedText: undefined });
    expect(fired.state.insertAt).toBe(6);
  });

  it("types a template where an insert command was spoken", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "here code block",
    });
    const fired = resolveVoiceCommand(heard.state, "here code block");
    expect(fired.edits[0]).toEqual({ start: 4, end: 15, text: "", expectedText: undefined });
    expect(fired.edits[1]).toEqual({
      start: 4,
      end: 4,
      text: "```\n\n```",
      expectedText: undefined,
    });
    expect(fired.state.insertAt).toBe(12);
    expect(fired.action).toBeNull();
  });

  it("undoes nothing when the previous utterance was already taken back", () => {
    const sealed = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "undo that",
    });
    const fired = resolveVoiceCommand(sealed.state, "undo that");
    expect(fired.edits).toEqual([{ start: 0, end: 9, text: "", expectedText: undefined }]);
  });

  it("drops a reply from an utterance the draft already finished with", () => {
    // A session's transcript is cumulative, so a late reply carries every word
    // it has heard. Once the draft has sealed that utterance — the user spoke
    // again, cleared, or undid — accepting one re-inserts all of it.
    const sealed = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "first thing said",
    });
    expect(sealed.state.sealedUtteranceId).toBe(1);

    const late = applyVoiceTranscript(sealed.state, {
      ...base,
      prompt: "first thing said",
      transcript: "first thing said",
    });
    expect(late.edits).toEqual([]);
    expect(late.state).toBe(sealed.state);

    // The next utterance still lands normally, after what was committed.
    const next = applyVoiceTranscript(sealed.state, {
      ...base,
      utteranceId: 2,
      prompt: "first thing said",
      transcript: "second",
    });
    expect(next.edits).toEqual([{ start: 16, end: 16, text: " second", expectedText: undefined }]);
  });

  it("does not rewrite a span left behind by an earlier utterance", () => {
    // The gate restarted mid-utterance: the words already on screen are the
    // user's, so the new utterance appends rather than overwriting them.
    const open = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      prompt: "",
      transcript: "half a thought",
    });
    const restarted = applyVoiceTranscript(open.state, {
      ...base,
      utteranceId: 2,
      prompt: "half a thought",
      transcript: "a new one",
    });
    expect(restarted.edits).toEqual([
      { start: 14, end: 14, text: " a new one", expectedText: undefined },
    ]);
  });

  it("marks only a finished plain utterance as an undo step", () => {
    const partial = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      prompt: "",
      transcript: "still speak",
    });
    // Whisper revises its own words; those revisions are not undo steps, and
    // no voice write is ever tagged — the step is recorded explicitly, because
    // a final that repeats the last partial writes nothing to carry a tag.
    expect(partial.history).toBe("historic");
    expect(partial.completed).toBe(false);

    const finished = applyVoiceTranscript(partial.state, {
      ...base,
      isFinal: true,
      prompt: "still speak",
      transcript: "still speaking",
    });
    expect(finished.history).toBe("historic");
    expect(finished.completed).toBe(true);

    // A command phrase is typed only to be stripped, so it is never a step —
    // one that was would leave an undo that cancels itself out and does
    // nothing, which is what "undo only undoes itself" looked like.
    const spoken = applyVoiceTranscript(finished.state, {
      ...base,
      utteranceId: 2,
      isFinal: true,
      prompt: "still speaking",
      transcript: "undo that",
    });
    expect(spoken.completed).toBe(false);
    expect(resolveVoiceCommand(spoken.state, "still speaking undo that").history).toBe("historic");
  });

  it("makes a clear undoable and leaves undo itself out of the history", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      isFinal: true,
      prompt: "",
      transcript: "scratch that",
    });
    expect(resolveVoiceCommand(heard.state, "scratch that").history).toBe("push");
  });

  it("moves the caret and deletes a line without touching the rest", () => {
    const lineCommands = [
      { action: "caretStart" as const, phrases: ["go to start"], delayMs: 0 },
      { action: "caretEnd" as const, phrases: ["go to end"], delayMs: 0 },
      { action: "caretNextLine" as const, phrases: ["next line"], delayMs: 0 },
      { action: "deleteLine" as const, phrases: ["delete line"], delayMs: 0 },
    ];
    const draft = "first\nsecond\nthird";
    const fire = (transcript: string, cursor: number) => {
      const heard = applyVoiceTranscript(voiceDraftStateAt(cursor), {
        ...base,
        commands: lineCommands,
        isFinal: true,
        prompt: draft,
        transcript,
      });
      const spoken = applyEdits(draft, heard.edits);
      const fired = resolveVoiceCommand(heard.state, spoken);
      return { fired, text: applyEdits(spoken, fired.edits) };
    };

    // Caret moves leave the text alone and report where to go.
    expect(fire("go to start", 8).fired).toMatchObject({ action: "caretStart" });
    expect(fire("go to start", 8).text).toBe(draft);
    expect(fire("go to start", 8).fired.state.insertAt).toBe(0);
    expect(fire("go to end", 0).fired.state.insertAt).toBe(draft.length);
    // From inside "second", the next line begins after it.
    expect(fire("next line", 8).fired.state.insertAt).toBe("first\nsecond\n".length);

    // Deleting takes the row, not just its contents.
    const deleted = fire("delete line", 8);
    expect(deleted.text).toBe("first\nthird");
    expect(deleted.fired.action).toBeNull();
  });

  it("carries an app command through to the composer", () => {
    const heard = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      commands: [
        {
          action: "keybinding" as const,
          phrases: ["new chat"],
          keybinding: "chat.new" as const,
          delayMs: 0,
        },
      ],
      isFinal: true,
      prompt: "",
      transcript: "new chat",
    });
    expect(heard.state.pending?.keybinding).toBe("chat.new");
    const fired = resolveVoiceCommand(heard.state, "new chat");
    expect(fired.action).toBe("keybinding");
    // Only the phrase is removed; pressing the shortcut is the composer's job.
    expect(fired.edits).toEqual([{ start: 0, end: 8, text: "", expectedText: undefined }]);
  });

  it("deletes the sentence at the caret, and the last one on demand", () => {
    const sentenceCommands = [
      { action: "deleteSentence" as const, phrases: ["delete sentence"], delayMs: 0 },
      { action: "deleteLastSentence" as const, phrases: ["delete last sentence"], delayMs: 0 },
    ];
    const draft = "First one. Second one. Third one.";
    const fire = (transcript: string, cursor: number) => {
      const heard = applyVoiceTranscript(voiceDraftStateAt(cursor), {
        ...base,
        commands: sentenceCommands,
        isFinal: true,
        prompt: draft,
        transcript,
      });
      const spoken = applyEdits(draft, heard.edits);
      const fired = resolveVoiceCommand(heard.state, spoken);
      return applyEdits(spoken, fired.edits);
    };

    // Caret inside "Second one." removes that sentence and closes the gap.
    expect(fire("delete sentence", 15)).toBe("First one. Third one.");
    // "Last" ignores the caret and takes the final sentence.
    expect(fire("delete last sentence", 15)).toBe("First one. Second one. ");
    // Caret in the first sentence removes only it.
    expect(fire("delete sentence", 3)).toBe("Second one. Third one.");
  });

  it("finds a sentence when the draft ends in whitespace", () => {
    // "new line" leaves a trailing newline, which used to send the bounds
    // search into infinite recursion and take out the renderer.
    const commands = [
      { action: "deleteLastSentence" as const, phrases: ["delete last sentence"], delayMs: 0 },
      { action: "deleteSentence" as const, phrases: ["delete sentence"], delayMs: 0 },
    ];
    const fire = (draft: string, transcript: string, cursor: number) => {
      const heard = applyVoiceTranscript(voiceDraftStateAt(cursor), {
        ...base,
        commands,
        isFinal: true,
        prompt: draft,
        transcript,
      });
      const spoken = applyEdits(draft, heard.edits);
      const fired = resolveVoiceCommand(heard.state, spoken);
      return applyEdits(spoken, fired.edits);
    };

    expect(fire("Hello world.\n", "delete last sentence", 13)).toBe("");
    expect(fire("Hello world. ", "delete last sentence", 13)).toBe("");
    // Whitespace alone has no sentence to take, and must not hang.
    expect(fire("   ", "delete sentence", 3)).toBe("   ");
    // A caret in the gap after a sentence refers to the one behind it.
    expect(fire("Hi. There.", "delete sentence", 3)).toBe("There.");
  });

  it("ignores an empty partial with no anchor", () => {
    const result = applyVoiceTranscript(voiceDraftStateAt(0), {
      ...base,
      prompt: "",
      transcript: "",
    });
    expect(result.edits).toEqual([]);
  });

  it("reports the provisional range only while a span is open", () => {
    const open = applyVoiceTranscript(voiceDraftStateAt(2), {
      ...base,
      prompt: "hi",
      transcript: "there",
    });
    expect(voiceProvisionalRange(open.state)).toEqual({ start: 2, end: 8 });
    const sealed = applyVoiceTranscript(open.state, {
      ...base,
      isFinal: true,
      prompt: "hi there",
      transcript: "there",
    });
    expect(voiceProvisionalRange(sealed.state)).toBeNull();
  });
});
