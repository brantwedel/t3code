export interface MicCaptureHandle {
  readonly sampleRate: number;
  readonly stop: () => void;
}

const workletModuleUrl = new URL("./voiceWorklet.js", import.meta.url);

/**
 * Open the microphone and stream fixed mono PCM frames at the context's
 * native sample rate; the session driver resamples to whisper's 16 kHz.
 */
export async function startMicCapture(
  onFrame: (frame: Float32Array) => void,
): Promise<MicCaptureHandle> {
  if (!window.isSecureContext) {
    throw new Error("Voice dictation needs a secure context (HTTPS or localhost).");
  }
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error("Microphone capture is not available in this browser.");
  }
  const stream = await navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    // Browsers word these differently and some say only "Permission denied",
    // which reads as an app failure rather than something the user can fix.
    .catch((cause: unknown) => {
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error("Microphone access was denied. Allow it for this site and try again.", {
          cause,
        });
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new Error("No microphone was found.", { cause });
      }
      if (name === "NotReadableError") {
        throw new Error("The microphone is in use by another application.", { cause });
      }
      throw cause;
    });
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(workletModuleUrl);
  } catch (cause) {
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => undefined);
    throw new Error("Could not start the audio capture worklet.", { cause });
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "t3-voice-pcm", {
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const handleFrame = (event: MessageEvent) => {
    if (event.data instanceof Float32Array) {
      onFrame(event.data);
    }
  };
  node.port.addEventListener("message", handleFrame);
  node.port.start();
  source.connect(node);
  // The processor emits silence; the destination connection keeps the graph pulled.
  node.connect(context.destination);
  return {
    sampleRate: context.sampleRate,
    stop: () => {
      node.port.removeEventListener("message", handleFrame);
      node.port.close();
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
    },
  };
}
