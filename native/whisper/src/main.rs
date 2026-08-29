use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc;
use std::thread;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// Mirrors `WhisperSidecarCommand` / `WhisperSidecarEvent` in
// `packages/contracts/src/voice.ts` field-for-field. Bump both together.
const PROTOCOL_VERSION: u32 = 1;

const TARGET_SAMPLE_RATE: usize = 16_000;
// Whisper hallucinates confidently on near-empty windows; skip those decodes.
const MIN_DECODE_SAMPLES: usize = TARGET_SAMPLE_RATE * 3 / 10;
// Sealing commits segments ending well behind the live edge and drops their
// audio, keeping per-tick decode cost bounded on any utterance length; the
// fallback pair force-trims when no segment boundary qualifies.
const SEAL_AFTER_SAMPLES: usize = TARGET_SAMPLE_RATE * 15;
const SEAL_KEEP_LIVE_SAMPLES: usize = TARGET_SAMPLE_RATE * 5;
const PROMPT_CARRY_CHARS: usize = 200;
const FALLBACK_SEAL_SAMPLES: usize = TARGET_SAMPLE_RATE * 60;
const FALLBACK_SEAL_KEEP_SAMPLES: usize = TARGET_SAMPLE_RATE * 30;
const INPUT_QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Command {
    LoadModel {
        version: u32,
        request_id: String,
        path: String,
    },
    SessionStart {
        version: u32,
        request_id: String,
        session_id: String,
        sample_rate: u32,
        #[serde(default)]
        language: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
    },
    SessionAppend {
        version: u32,
        request_id: String,
        session_id: String,
        #[serde(default)]
        pcm: String,
        #[serde(default)]
        offset_bytes: u64,
        #[serde(default, rename = "final")]
        is_final: bool,
    },
    SessionClose {
        version: u32,
        request_id: String,
        session_id: String,
    },
    Shutdown {
        version: u32,
    },
}

impl Command {
    fn version(&self) -> u32 {
        match self {
            Self::LoadModel { version, .. }
            | Self::SessionStart { version, .. }
            | Self::SessionAppend { version, .. }
            | Self::SessionClose { version, .. }
            | Self::Shutdown { version } => *version,
        }
    }

    fn request_id(&self) -> Option<&str> {
        match self {
            Self::LoadModel { request_id, .. }
            | Self::SessionStart { request_id, .. }
            | Self::SessionAppend { request_id, .. }
            | Self::SessionClose { request_id, .. } => Some(request_id),
            Self::Shutdown { .. } => None,
        }
    }
}

enum Input {
    Command(Command),
    Invalid(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    backends: Vec<&'static str>,
    streaming: bool,
    sealing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sidecar_version: &'static str,
    sidecar_pid: u32,
    platform: &'static str,
    arch: &'static str,
    capabilities: Capabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OkEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    text: String,
    t0_ms: u64,
    t1_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: String,
    session_id: String,
    text: String,
    segments: Vec<Segment>,
    is_final: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    code: &'static str,
    message: String,
    recoverable: bool,
}

/// whisper-rs's CString setters panic on NUL, and these fields are client input.
fn strip_nul(text: &str) -> String {
    text.replace('\0', "")
}

struct Session {
    sample_rate: u32,
    language: Option<String>,
    base_prompt: Option<String>,
    /// Live window, 16 kHz mono f32; sealed audio is dropped from the front.
    audio: Vec<f32>,
    /// Dedup cursor: bytes of client PCM accepted so far.
    accepted_bytes: u64,
    sealed_text: String,
    sealed_segments: Vec<Segment>,
    /// Utterance time where the live window starts, keeping all timestamps on one axis.
    sealed_ms: u64,
}

impl Session {
    fn new(sample_rate: u32, language: Option<String>, base_prompt: Option<String>) -> Self {
        Self {
            sample_rate,
            language: language.map(|value| strip_nul(&value)),
            base_prompt: base_prompt.map(|value| strip_nul(&value)),
            audio: Vec::new(),
            accepted_bytes: 0,
            sealed_text: String::new(),
            sealed_segments: Vec::new(),
            sealed_ms: 0,
        }
    }

    fn append_pcm(&mut self, pcm_base64: &str, offset_bytes: u64) -> Result<(), String> {
        if self.sample_rate == 0 {
            return Err("session has a zero sample rate".to_string());
        }
        if pcm_base64.is_empty() {
            return Ok(());
        }
        let bytes = BASE64
            .decode(pcm_base64)
            .map_err(|error| format!("pcm is not valid base64: {error}"))?;
        if bytes.len() % 2 != 0 {
            return Err(format!("pcm has an odd byte length ({})", bytes.len()));
        }
        if offset_bytes > self.accepted_bytes {
            return Err(format!(
                "pcm offset {offset_bytes} is past the accepted {} bytes",
                self.accepted_bytes
            ));
        }
        let skip = (self.accepted_bytes - offset_bytes) as usize;
        if skip >= bytes.len() {
            return Ok(());
        }
        let fresh = &bytes[skip..];
        let samples: Vec<f32> = fresh
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32_768.0)
            .collect();
        if self.sample_rate as usize == TARGET_SAMPLE_RATE {
            self.audio.extend_from_slice(&samples);
        } else {
            self.audio
                .extend_from_slice(&resample_linear(&samples, self.sample_rate as usize, TARGET_SAMPLE_RATE));
        }
        self.accepted_bytes = offset_bytes + bytes.len() as u64;
        // Drop whole milliseconds so the timestamp axis stays exact.
        if self.audio.len() > FALLBACK_SEAL_SAMPLES {
            let excess = self.audio.len() - FALLBACK_SEAL_KEEP_SAMPLES;
            let samples_per_ms = TARGET_SAMPLE_RATE / 1000;
            let drop_ms = (excess / samples_per_ms) as u64;
            let drop_samples = drop_ms as usize * samples_per_ms;
            self.audio.drain(..drop_samples);
            self.sealed_ms += drop_ms;
        }
        Ok(())
    }

    fn initial_prompt(&self) -> Option<String> {
        let carry: String = strip_nul(&tail_chars(&self.sealed_text, PROMPT_CARRY_CHARS));
        match (&self.base_prompt, carry.is_empty()) {
            (Some(base), true) => Some(base.clone()),
            (Some(base), false) => Some(format!("{base} {carry}")),
            (None, true) => None,
            (None, false) => Some(carry),
        }
    }

    /// Commit segments ending well behind the live edge and drop their audio.
    /// Runs after the reply is built, so the caller's transcript is unaffected.
    fn seal(&mut self, live_segments: &[Segment]) {
        if self.audio.len() <= SEAL_AFTER_SAMPLES {
            return;
        }
        let live_edge_ms = (self.audio.len() * 1000 / TARGET_SAMPLE_RATE) as u64;
        let keep_live_ms = (SEAL_KEEP_LIVE_SAMPLES * 1000 / TARGET_SAMPLE_RATE) as u64;
        let boundary_limit_ms = live_edge_ms.saturating_sub(keep_live_ms);
        let mut seal_until_ms = 0u64;
        let mut seal_count = 0usize;
        for segment in live_segments {
            let relative_end = segment.t1_ms.saturating_sub(self.sealed_ms);
            if relative_end <= boundary_limit_ms {
                seal_until_ms = relative_end;
                seal_count += 1;
            } else {
                break;
            }
        }
        if seal_count == 0 {
            return;
        }
        for segment in &live_segments[..seal_count] {
            if !self.sealed_text.is_empty() {
                self.sealed_text.push(' ');
            }
            self.sealed_text.push_str(segment.text.trim());
            self.sealed_segments.push(segment.clone());
        }
        let drop_samples = (seal_until_ms as usize * TARGET_SAMPLE_RATE / 1000).min(self.audio.len());
        self.audio.drain(..drop_samples);
        self.sealed_ms += seal_until_ms;
    }
}

fn tail_chars(text: &str, count: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(count);
    chars[start..].iter().collect()
}

fn resample_linear(source: &[f32], from_rate: usize, to_rate: usize) -> Vec<f32> {
    if from_rate == to_rate || source.is_empty() {
        return source.to_vec();
    }
    let out_len = source.len() * to_rate / from_rate;
    let mut out = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let position = index as f64 * from_rate as f64 / to_rate as f64;
        let base = position.floor() as usize;
        let fraction = (position - base as f64) as f32;
        let a = source[base.min(source.len() - 1)];
        let b = source[(base + 1).min(source.len() - 1)];
        out.push(a + (b - a) * fraction);
    }
    out
}

/// Above this, whisper itself reports the window is not speech.
const NO_SPEECH_PROBABILITY_LIMIT: f32 = 0.6;
/// A phrase repeated this many times in a row is whisper looping, not speech.
const MAX_SEGMENT_REPEATS: usize = 2;

/// Strip runaway repetition — on non-speech whisper often emits one phrase
/// over and over ("I'm going to go ahead and get the one." ×6).
fn drop_looping_segments(segments: &mut Vec<(String, i64, i64)>) {
    let mut runs = 0usize;
    let mut previous: Option<String> = None;
    segments.retain(|(text, _, _)| {
        let key = text.trim().to_lowercase();
        if previous.as_deref() == Some(key.as_str()) {
            runs += 1;
        } else {
            runs = 0;
            previous = Some(key);
        }
        runs < MAX_SEGMENT_REPEATS
    });
}

/// `[BLANK_AUDIO]`, `(wind blowing)`, `♪` — whisper narrating non-speech.
fn is_noise_marker(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty()
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('(') && trimmed.ends_with(')'))
        || trimmed.chars().all(|character| !character.is_alphanumeric())
}

struct Engine {
    context: Option<(WhisperContext, String)>,
    sessions: HashMap<String, Session>,
    threads: i32,
}

impl Engine {
    fn new() -> Self {
        let threads = thread::available_parallelism()
            .map(|parallelism| parallelism.get().min(4) as i32)
            .unwrap_or(2);
        Self {
            context: None,
            sessions: HashMap::new(),
            threads,
        }
    }

    fn load_model(&mut self, path: &str) -> Result<(), String> {
        if let Some((_, loaded_path)) = &self.context {
            if loaded_path == path {
                return Ok(());
            }
        }
        let parameters = WhisperContextParameters::default();
        let context = WhisperContext::new_with_params(path, parameters)
            .map_err(|error| format!("failed to load model at '{path}': {error}"))?;
        self.context = Some((context, path.to_string()));
        Ok(())
    }

    /// Re-transcribe the session's live window. Returns the full transcript
    /// (sealed prefix + live tail) and the segments on the utterance axis.
    fn transcribe(&mut self, session_id: &str) -> Result<(String, Vec<Segment>), String> {
        let (context, _) = self
            .context
            .as_ref()
            .ok_or_else(|| "no model loaded".to_string())?;
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown session '{session_id}'"))?;

        let live_segments = if session.audio.len() < MIN_DECODE_SAMPLES {
            Vec::new()
        } else {
            // whisper-rs 0.16 leaks one small CString per set_language /
            // set_initial_prompt call; bounded by the server's idle shutdown.
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_n_threads(self.threads);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_suppress_blank(true);
            params.set_suppress_nst(true);
            let language = session.language.as_deref().unwrap_or("en");
            params.set_language(Some(language));
            let prompt = session.initial_prompt();
            if let Some(prompt) = prompt.as_deref() {
                params.set_initial_prompt(prompt);
            }

            // Fresh state per decode: cheap on CPU/Metal, seconds on coreml —
            // revisit before enabling that feature.
            let mut state = context
                .create_state()
                .map_err(|error| format!("failed to create decode state: {error}"))?;
            // A panic cannot unwind through the C frames, so a caught panic
            // implies the FFI call returned and the state is intact.
            let decode = catch_unwind(AssertUnwindSafe(|| state.full(params, &session.audio)));
            match decode {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => return Err(format!("decode failed: {error}")),
                Err(_) => return Err("decode panicked".to_string()),
            }
            let mut raw_segments = Vec::new();
            for segment in state.as_iter() {
                // Whisper's own verdict that a window holds no speech. Without
                // this it narrates silence with training-data filler.
                if segment.no_speech_probability() > NO_SPEECH_PROBABILITY_LIMIT {
                    continue;
                }
                let text = segment.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default();
                raw_segments.push((text, segment.start_timestamp(), segment.end_timestamp()));
            }
            drop_looping_segments(&mut raw_segments);
            raw_segments
                .into_iter()
                .filter(|(text, _, _)| !is_noise_marker(text))
                .map(|(text, t0, t1)| Segment {
                    text: text.trim().to_string(),
                    // Centiseconds relative to the live window → utterance ms.
                    t0_ms: session.sealed_ms + (t0.max(0) as u64) * 10,
                    t1_ms: session.sealed_ms + (t1.max(0) as u64) * 10,
                })
                .collect()
        };

        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown session '{session_id}'"))?;
        let live_text = live_segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let full_text = if session.sealed_text.is_empty() {
            live_text
        } else if live_text.is_empty() {
            session.sealed_text.clone()
        } else {
            format!("{} {}", session.sealed_text, live_text)
        };
        let mut full_segments = session.sealed_segments.clone();
        full_segments.extend(live_segments.iter().cloned());

        session.seal(&live_segments);

        Ok((full_text, full_segments))
    }
}

fn spawn_input_reader() -> mpsc::Receiver<Input> {
    let (sender, receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(Input::Invalid(format!("stdin read failed: {error}")));
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let input = match serde_json::from_str::<Command>(&line) {
                Ok(command) => Input::Command(command),
                Err(error) => Input::Invalid(format!("unparseable command: {error}")),
            };
            if sender.send(input).is_err() {
                break;
            }
        }
    });
    receiver
}

fn write_event<W: Write, T: Serialize>(writer: &mut W, event: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_error<W: Write>(
    writer: &mut W,
    request_id: Option<&str>,
    code: &'static str,
    message: String,
    recoverable: bool,
) -> io::Result<()> {
    write_event(
        writer,
        &ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            request_id: request_id.map(str::to_string),
            code,
            message,
            recoverable,
        },
    )
}

fn backends() -> Vec<&'static str> {
    let mut backends = Vec::new();
    if cfg!(feature = "metal") {
        backends.push("metal");
    }
    if cfg!(feature = "cuda") {
        backends.push("cuda");
    }
    if cfg!(feature = "vulkan") {
        backends.push("vulkan");
    }
    if cfg!(feature = "coreml") {
        backends.push("coreml");
    }
    backends.push("cpu");
    backends
}

fn main() -> io::Result<()> {
    // Route whisper.cpp/ggml logging into the unconfigured (silent) log
    // facade so C-side output can never corrupt the NDJSON stdout stream.
    whisper_rs::install_logging_hooks();

    let mut writer = BufWriter::new(io::stdout().lock());
    write_event(
        &mut writer,
        &HelloEvent {
            version: PROTOCOL_VERSION,
            event_type: "hello",
            sidecar_version: env!("CARGO_PKG_VERSION"),
            sidecar_pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            capabilities: Capabilities {
                backends: backends(),
                streaming: true,
                sealing: true,
            },
        },
    )?;

    let receiver = spawn_input_reader();
    let mut engine = Engine::new();

    while let Ok(input) = receiver.recv() {
        let command = match input {
            Input::Command(command) => command,
            Input::Invalid(message) => {
                write_error(&mut writer, None, "invalid-command", message, true)?;
                continue;
            }
        };
        if command.version() != PROTOCOL_VERSION {
            write_error(
                &mut writer,
                command.request_id(),
                "protocol-mismatch",
                format!(
                    "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                    command.version()
                ),
                false,
            )?;
            continue;
        }

        match command {
            Command::LoadModel { request_id, path, .. } => match engine.load_model(&path) {
                Ok(()) => write_event(
                    &mut writer,
                    &OkEvent {
                        version: PROTOCOL_VERSION,
                        event_type: "ok",
                        request_id,
                    },
                )?,
                Err(message) => {
                    write_error(&mut writer, Some(&request_id), "load-model-failed", message, true)?
                }
            },
            Command::SessionStart {
                request_id,
                session_id,
                sample_rate,
                language,
                prompt,
                ..
            } => {
                if engine.context.is_none() {
                    write_error(
                        &mut writer,
                        Some(&request_id),
                        "no-model",
                        "load a model before starting a session".to_string(),
                        true,
                    )?;
                    continue;
                }
                engine
                    .sessions
                    .insert(session_id, Session::new(sample_rate, language, prompt));
                write_event(
                    &mut writer,
                    &OkEvent {
                        version: PROTOCOL_VERSION,
                        event_type: "ok",
                        request_id,
                    },
                )?;
            }
            Command::SessionAppend {
                request_id,
                session_id,
                pcm,
                offset_bytes,
                is_final,
                ..
            } => {
                if let Some(session) = engine.sessions.get_mut(&session_id) {
                    if let Err(message) = session.append_pcm(&pcm, offset_bytes) {
                        write_error(&mut writer, Some(&request_id), "bad-audio", message, true)?;
                        continue;
                    }
                } else {
                    write_error(
                        &mut writer,
                        Some(&request_id),
                        "unknown-session",
                        format!("unknown session '{session_id}'"),
                        true,
                    )?;
                    continue;
                }
                match engine.transcribe(&session_id) {
                    Ok((text, segments)) => {
                        if is_final {
                            engine.sessions.remove(&session_id);
                        }
                        write_event(
                            &mut writer,
                            &TranscriptEvent {
                                version: PROTOCOL_VERSION,
                                event_type: "transcript",
                                request_id,
                                session_id,
                                text,
                                segments,
                                is_final,
                            },
                        )?;
                    }
                    Err(message) => {
                        write_error(&mut writer, Some(&request_id), "decode-failed", message, true)?
                    }
                }
            }
            Command::SessionClose {
                request_id,
                session_id,
                ..
            } => {
                engine.sessions.remove(&session_id);
                write_event(
                    &mut writer,
                    &OkEvent {
                        version: PROTOCOL_VERSION,
                        event_type: "ok",
                        request_id,
                    },
                )?;
            }
            Command::Shutdown { .. } => break,
        }
    }

    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session::new(16_000, Some("en".to_string()), None)
    }

    fn pcm_base64(bytes: usize) -> String {
        BASE64.encode(vec![7u8; bytes])
    }

    #[test]
    fn decodes_protocol_commands() {
        let append: Command = serde_json::from_str(
            r#"{"version":1,"type":"sessionAppend","requestId":"r1","sessionId":"s1","pcm":"","offsetBytes":640,"final":true}"#,
        )
        .expect("append decodes");
        match append {
            Command::SessionAppend { offset_bytes, is_final, .. } => {
                assert_eq!(offset_bytes, 640);
                assert!(is_final);
            }
            other => panic!("unexpected command: {other:?}"),
        }
        let start: Command = serde_json::from_str(
            r#"{"version":1,"type":"sessionStart","requestId":"r1","sessionId":"s1","sampleRate":16000}"#,
        )
        .expect("start without optionals decodes");
        match start {
            Command::SessionStart { language, prompt, .. } => {
                assert!(language.is_none());
                assert!(prompt.is_none());
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn error_event_matches_wire_shape() {
        let json = serde_json::to_string(&ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            request_id: None,
            code: "x",
            message: "boom".to_string(),
            recoverable: true,
        })
        .expect("serializes");
        assert!(json.contains(r#""message":"boom""#));
        assert!(!json.contains("requestId"));
    }

    #[test]
    fn append_dedups_replays_by_offset() {
        let mut s = session();
        s.append_pcm(&pcm_base64(640), 0).expect("first append");
        assert_eq!(s.audio.len(), 320);
        assert_eq!(s.accepted_bytes, 640);
        // Full replay appends nothing.
        s.append_pcm(&pcm_base64(640), 0).expect("replay");
        assert_eq!(s.audio.len(), 320);
        // Overlapping retry contributes only the unseen tail.
        s.append_pcm(&pcm_base64(640), 320).expect("overlap");
        assert_eq!(s.audio.len(), 480);
        assert_eq!(s.accepted_bytes, 960);
        // A gap past the cursor is a client bug.
        assert!(s.append_pcm(&pcm_base64(2), 5_000).is_err());
    }

    #[test]
    fn append_rejects_bad_audio() {
        let mut s = session();
        assert!(s.append_pcm("not base64!!", 0).is_err());
        assert!(s.append_pcm(&BASE64.encode([1u8, 2, 3]), 0).is_err());
        assert_eq!(s.accepted_bytes, 0);
    }

    #[test]
    fn seal_commits_only_segments_behind_the_live_edge() {
        let mut s = session();
        s.audio = vec![0.0; TARGET_SAMPLE_RATE * 20];
        let live = vec![
            Segment { text: "early".to_string(), t0_ms: 0, t1_ms: 4_000 },
            Segment { text: "late".to_string(), t0_ms: 4_000, t1_ms: 19_000 },
        ];
        s.seal(&live);
        assert_eq!(s.sealed_text, "early");
        assert_eq!(s.sealed_ms, 4_000);
        assert_eq!(s.audio.len(), TARGET_SAMPLE_RATE * 16);
        // Under the threshold nothing seals.
        let mut small = session();
        small.audio = vec![0.0; TARGET_SAMPLE_RATE * 10];
        small.seal(&[Segment { text: "x".to_string(), t0_ms: 0, t1_ms: 1_000 }]);
        assert_eq!(small.sealed_text, "");
    }

    #[test]
    fn fallback_seal_bounds_the_window() {
        let mut s = session();
        for _ in 0..70 {
            s.append_pcm(&pcm_base64(TARGET_SAMPLE_RATE * 2), s.accepted_bytes)
                .expect("append");
        }
        assert!(s.audio.len() <= FALLBACK_SEAL_SAMPLES);
        assert!(s.sealed_ms > 0);
    }

    #[test]
    fn noise_markers_and_nul_stripping() {
        assert!(is_noise_marker("[BLANK_AUDIO]"));
        assert!(is_noise_marker("(wind blowing)"));
        assert!(is_noise_marker("  "));
        assert!(!is_noise_marker("hello"));
        assert_eq!(strip_nul("en\0"), "en");
    }

    #[test]
    fn resample_halves_at_double_rate() {
        let out = resample_linear(&[0.0; 64], 32_000, 16_000);
        assert_eq!(out.len(), 32);
    }
}
