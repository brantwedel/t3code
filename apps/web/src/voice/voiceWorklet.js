// AudioWorklet processor: downmixes the input to mono and posts fixed-size
// frames to the main thread. Plain JS on purpose — the worklet module is
// served as-is via `new URL(..., import.meta.url)` because the desktop CSP
// allows only same-origin worklet scripts (no blob: URLs).
const FRAME_SAMPLES = 2048;

class T3VoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const first = input[0];
    if (!first || first.length === 0) return true;
    let mono = first;
    if (input.length > 1) {
      mono = new Float32Array(first.length);
      for (let channel = 0; channel < input.length; channel += 1) {
        const data = input[channel];
        for (let index = 0; index < data.length; index += 1) {
          mono[index] += data[index] / input.length;
        }
      }
    }
    let offset = 0;
    while (offset < mono.length) {
      const take = Math.min(this.pending.length - this.filled, mono.length - offset);
      this.pending.set(mono.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.pending.length) {
        const frame = this.pending;
        this.pending = new Float32Array(FRAME_SAMPLES);
        this.filled = 0;
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("t3-voice-pcm", T3VoicePcmProcessor);
