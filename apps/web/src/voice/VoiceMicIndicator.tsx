import { useEffect, useState } from "react";

import type { VoiceDictationActivity, VoiceDictationStatus } from "./useVoiceDictation";

const POLL_MS = 90;
const BARS = ["a", "b", "c", "d"] as const;
/** Per-bar shape so the waveform reads as speech, not a flat block. */
const BAR_WEIGHTS = [0.55, 1, 0.8, 0.4];
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 14;
const FLAT_HEIGHTS = [3, 3, 3, 3];
/** Held shape for the states where no audio is being read; distinct from the
 *  flat resting waveform so waiting never looks like hearing silence. */
const HELD_HEIGHTS = [5, 8, 8, 5];

/**
 * Waveform shown in place of the mic icon while dictation is live: bar
 * heights follow your voice, so the button itself reports that audio is
 * getting through. Heights are quantized so it repaints only on real change.
 *
 * Opening the microphone and finalizing an utterance read no audio at all, so
 * they hold a fixed shape and say so — a waveform sitting flat through a model
 * load looks like a mic that is listening and hearing nothing.
 */
export function VoiceMicIndicator(props: {
  readonly getActivity: () => VoiceDictationActivity;
  readonly status: VoiceDictationStatus;
}) {
  const { getActivity, status } = props;
  const [heights, setHeights] = useState<ReadonlyArray<number>>(FLAT_HEIGHTS);
  const [finalizing, setFinalizing] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const activity = getActivity();
      setFinalizing((previous) =>
        previous === activity.finalizing ? previous : activity.finalizing,
      );
      const strength = Math.min(1, Math.sqrt(activity.level) * 2.6);
      const next = BAR_WEIGHTS.map((weight) => {
        const raw = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * strength * weight;
        // Snap to 2px steps: visible motion without repainting every tick.
        return Math.max(MIN_HEIGHT, Math.round(raw / 2) * 2);
      });
      setHeights((previous) =>
        previous.every((value, index) => value === next[index]) ? previous : next,
      );
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [getActivity]);

  const waiting = status === "starting" ? "Starting dictation" : finalizing ? "Transcribing" : null;
  const shown = waiting === null ? heights : HELD_HEIGHTS;

  return (
    <span
      className={
        waiting === null
          ? "flex h-4 items-center justify-center gap-[2px]"
          : "flex h-4 items-center justify-center gap-[2px] opacity-60"
      }
      role="img"
      aria-label={waiting ?? "Listening"}
    >
      {BARS.map((bar, index) => (
        <span
          key={bar}
          className="w-[2px] rounded-full bg-current"
          style={{ height: `${shown[index]}px` }}
        />
      ))}
    </span>
  );
}
