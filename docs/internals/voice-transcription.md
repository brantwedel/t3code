# Voice transcription architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

Status: implemented (web + desktop clients and CLI packaging; mobile pending)

## Purpose

Streaming dictation transcribed by a local whisper model. The server owns the model and the
decoder; clients own the microphone and voice-activity detection. Any client — including a phone
that could never run the model — gets transcription over the same authenticated WebSocket it
already uses, across local, LAN, Tailscale, and relay connections alike.

## Topology

```text
Client (web/desktop)                     apps/server                    native/whisper (Rust)
  AudioWorklet mic capture                VoiceTranscription              whisper.cpp via whisper-rs
  VAD + PCM ring                 ──ws──▶  session map + cursor   ──────▶  one model, per-session
  VoiceSessionDriver (ticks)              dedup + tombstones     NDJSON   decode state, sealing
```

The sidecar follows the resource-monitor pattern exactly: a supervised child process speaking
versioned NDJSON on stdio, restarted with a failure budget ([`WhisperSidecarClient.ts`][client]).
Two deliberate differences: it starts on demand rather than at boot and exits after ten idle
minutes (a loaded model holds hundreds of MB of RSS), and its release profile omits
`panic = "abort"` because a caught decode panic fails one request, not every live session.

## Session protocol

Clients drive `voice.sessionStart` / `voice.sessionAppend` / `voice.sessionClose`
([`voice.ts`][contracts]). Appends carry base64 int16 PCM plus a byte cursor; the cursor advances
only when a reply is received, so a client retries a failed append with the identical bytes.
Overlap is dropped twice — in [`VoiceTranscription.ts`][service] and again inside the sidecar —
so audio is never decoded twice even when a reply is lost after the sidecar consumed it. A
finalized session leaves a short-lived tombstone so a retried final still recovers its transcript.

Every reply carries the full utterance text; clients replace their dictated span wholesale, never
append, because whisper revises earlier words as context grows. Segment timestamps stay on one
utterance axis across sealing.

A server that stops answering is assumed to be coming back. For `VOICE_RESUME_WINDOW_MS` (5 s) the
client keeps the microphone open and the utterance alive: appends retry their identical chunk, and
a `sessionStart` that cannot be reached retries on the same tick while audio accumulates in the
ring, so a reconnect or a network handover costs a pause rather than the rest of the sentence. Past
the window the session is abandoned and a fresh one opens; the server retires its own side after
`SESSION_IDLE_TIMEOUT_MS` (5 min), well beyond any resume. Sessions are capped per environment so
starts abandoned mid-handshake cannot accumulate faster than the sweeper clears them.

## Sealing

The sidecar re-transcribes its live window on every append. To keep that bounded, once the window
passes 15 s it commits segments ending more than 5 s behind the live edge — their text is sealed,
their audio dropped, and a tail of the sealed text carries into the next decode as vocabulary
context. A fallback trim fires at 60 s when no segment boundary qualifies (all-noise audio). The
whole mechanism is invisible on the wire.

## Models

[`VoiceModelStore.ts`][models] pins upstream ggml URLs with sha256 digests, streams downloads to a
`.part` file, and renames into place only after the digest verifies. Models live under the base
directory's `caches/whisper/`. `voice.ensureModel` is a streaming RPC reporting download progress,
shaped like `serverUpdateServerWithProgress`.

## Binary resolution

[`WhisperBinary.ts`][binary] mirrors `ResourceMonitorBinary.ts`: env override
(`T3CODE_WHISPER_PATH`), staged resources, then cargo target directories for development. A missing
binary degrades to `supported: false` in `voice.getStatus`; nothing hard-fails.

Packaging follows the resource monitor at every step — `stageWhisper` in
`build-desktop-artifact.ts` for the Electron app, and cache/collect/upload/bundle steps in
`release.yml` that also place the binary in `apps/server/dist/whisper/<platform>-<arch>/` so the
`npx t3` package carries it. Electron denies `getUserMedia` by default, so the main window grants
the microphone to its own contents in `DesktopWindow.ts`; without that the packaged app can capture
nothing. Every shipped build is CPU-only — `whisper-rs` accelerator features are opt-in and nothing
enables one, which keeps macOS, Linux and Windows on the same build.

## Draft model (client)

[`draft.ts`][draft] is a pure state machine so the composer holds no dictation logic of its own.
Three invariants carry the weight:

- **Transcripts are cumulative.** A session returns everything it has heard, so a reply is applied
  by replacing the utterance's span, never appending. Each reply is tagged with the utterance that
  produced it; one at or below `sealedUtteranceId` is dropped rather than inserted, which is what
  stops a late or replayed reply from re-inserting text a command already removed.
- **A session that no longer describes the draft is abandoned.** Typing, a command, or a thread
  switch all drop the in-flight session and open a fresh one — otherwise its next reply carries
  words the draft has moved past.
- **Nothing reaches the undo history until an utterance finishes.** Whisper's final transcript
  usually repeats the last partial verbatim, so the completing write often changes nothing and can
  carry no tag; the step is recorded explicitly instead. Command phrases are typed into the draft
  and stripped again, so they are tagged historic and never become a step of their own.

Commands match only at the END of a finalized utterance ([`commands.ts`][commands]), comparing
tokens rather than raw words so filler words, one-word/two-word compounds, and spelling variants
all normalize on both sides.

[client]: ../../apps/server/src/voice/WhisperSidecarClient.ts
[contracts]: ../../packages/contracts/src/voice.ts
[service]: ../../apps/server/src/voice/VoiceTranscription.ts
[models]: ../../apps/server/src/voice/VoiceModelStore.ts
[binary]: ../../apps/server/src/voice/WhisperBinary.ts
[draft]: ../../packages/client-runtime/src/voice/draft.ts
[commands]: ../../packages/client-runtime/src/voice/commands.ts
