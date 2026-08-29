import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema } from "./settings.ts";
import {
  DEFAULT_VOICE_COMMANDS,
  DEFAULT_VOICE_MODEL,
  VoicePcmChunk,
  VoiceSessionAppendInput,
  VoiceSessionStartInput,
  WHISPER_SIDECAR_PROTOCOL_VERSION,
  WhisperSidecarCommand,
  WhisperSidecarEvent,
  withMissingVoiceCommands,
} from "./voice.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePcmChunk = Schema.decodeUnknownSync(VoicePcmChunk);
const decodeAppendInput = Schema.decodeUnknownSync(VoiceSessionAppendInput);
const decodeStartInput = Schema.decodeUnknownSync(VoiceSessionStartInput);
const decodeSidecarEvent = Schema.decodeUnknownSync(WhisperSidecarEvent);
const encodeSidecarCommand = Schema.encodeSync(WhisperSidecarCommand);

describe("voice client settings", () => {
  it("defaults dictation off with the base English model", () => {
    const settings = decodeClientSettings({});
    expect(settings.voiceDictationEnabled).toBe(false);
    expect(settings.voiceDictationModel).toBe(DEFAULT_VOICE_MODEL);
    expect(settings.voiceDictationLanguage).toBe("");
  });

  it("rejects an unknown dictation model", () => {
    expect(() => decodeClientSettings({ voiceDictationModel: "large-v3" })).toThrow();
  });
});

describe("VoicePcmChunk", () => {
  it("accepts base64 audio, including the empty final flush", () => {
    expect(decodePcmChunk("AAECAw==")).toBe("AAECAw==");
    expect(decodePcmChunk("")).toBe("");
  });

  it("rejects strings that are not base64", () => {
    expect(() => decodePcmChunk("not base64!!")).toThrow();
  });
});

describe("voice session inputs", () => {
  it("decodes an append with a byte cursor", () => {
    const input = decodeAppendInput({
      sessionId: "vs-1",
      pcm: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      offsetBytes: 0,
      final: false,
    });
    expect(input.offsetBytes).toBe(0);
    expect(input.final).toBe(false);
  });

  it("rejects a negative cursor", () => {
    expect(() =>
      decodeAppendInput({ sessionId: "vs-1", pcm: "", offsetBytes: -1, final: true }),
    ).toThrow();
  });

  it("keeps language and prompt optional on session start", () => {
    const input = decodeStartInput({ model: "base.en", sampleRate: 16000 });
    expect("language" in input).toBe(false);
    expect("prompt" in input).toBe(false);
  });
});

describe("whisper sidecar protocol", () => {
  it("round-trips a transcript event", () => {
    const event = decodeSidecarEvent({
      version: WHISPER_SIDECAR_PROTOCOL_VERSION,
      type: "transcript",
      requestId: "r1",
      sessionId: "vs-1",
      text: "hello world",
      segments: [{ text: "hello world", t0Ms: 0, t1Ms: 820 }],
      isFinal: false,
    });
    expect(event.type).toBe("transcript");
  });

  it("rejects a protocol version the client does not speak", () => {
    expect(() => decodeSidecarEvent({ version: 99, type: "ok", requestId: "r1" })).toThrow();
  });

  it("encodes commands without dropping optional fields that are present", () => {
    const encoded = encodeSidecarCommand({
      version: WHISPER_SIDECAR_PROTOCOL_VERSION,
      type: "sessionStart",
      requestId: "r1",
      sessionId: "vs-1",
      sampleRate: 16000,
      language: "en",
    });
    expect(encoded).toMatchObject({ type: "sessionStart", language: "en" });
    expect("prompt" in encoded).toBe(false);
  });
});

describe("withMissingVoiceCommands", () => {
  it("fills in built-ins a saved setting predates", () => {
    const saved = DEFAULT_VOICE_COMMANDS.filter((command) => command.action !== "undo");
    const merged = withMissingVoiceCommands(saved);
    expect(merged.map((command) => command.action)).toContain("undo");
    // Existing entries keep their position and their customised phrases.
    expect(merged.slice(0, saved.length)).toEqual(saved);
  });

  it("leaves a command the user disabled switched off", () => {
    const disabled = DEFAULT_VOICE_COMMANDS.map((command) =>
      command.action === "clear" ? { ...command, phrases: [] } : command,
    );
    const merged = withMissingVoiceCommands(disabled);
    expect(merged.find((command) => command.action === "clear")?.phrases).toEqual([]);
  });

  it("leaves app commands the user deleted deleted", () => {
    const kept = DEFAULT_VOICE_COMMANDS.filter((command) => command.action !== "keybinding");
    const merged = withMissingVoiceCommands(kept);
    expect(merged.some((command) => command.action === "keybinding")).toBe(false);
  });
});
