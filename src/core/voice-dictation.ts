/** Hard stop for a single dictation session. A forgotten microphone must not
 * remain live indefinitely, even though browser speech recognition itself is
 * not billed by GalapagOS. */
export const MAX_DICTATION_MS = 10 * 60 * 1000;

export function mergeDictationIntoDraft(draft: string, transcript: string): string {
  const spoken = transcript.trim();
  if (!spoken) {
    return draft;
  }
  if (!draft) {
    return spoken;
  }
  return `${draft}${/\s$/.test(draft) ? "" : " "}${spoken}`;
}

export function formatDictationDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
