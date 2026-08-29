import { createContext, useContext, useEffect, type ReactNode } from "react";

import {
  useVoiceDictation,
  type VoiceDictationHandle,
  type VoiceTranscriptSink,
} from "./useVoiceDictation";

const VoiceDictationContext = createContext<VoiceDictationHandle | null>(null);

/**
 * Owns the microphone for the whole chat area. Composers are per route, and
 * sending the first message of a draft swaps one out mid-utterance, so the
 * session lives above the routes and composers only claim its transcripts.
 */
export function VoiceDictationProvider({ children }: { children: ReactNode }) {
  const dictation = useVoiceDictation();
  return (
    <VoiceDictationContext.Provider value={dictation}>{children}</VoiceDictationContext.Provider>
  );
}

/** Claim dictation transcripts for the calling composer. */
export function useVoiceDictationSession(onTranscript: VoiceTranscriptSink): VoiceDictationHandle {
  const dictation = useContext(VoiceDictationContext);
  const setTranscriptSink = dictation?.setTranscriptSink;
  useEffect(() => setTranscriptSink?.(onTranscript), [onTranscript, setTranscriptSink]);
  if (dictation === null) {
    throw new Error("useVoiceDictationSession requires a VoiceDictationProvider.");
  }
  return dictation;
}
