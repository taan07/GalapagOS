// Timestamp rendering for the UI (user-confirmed finding, 2026-07-05):
// SQLite stores UTC ISO strings — correct for storage, wrong to show raw.
// Everything the user sees converts to THEIR system clock and timezone here,
// at the render layer. Never slice an ISO string for display.

/** "18:59:10" in the user's local timezone. */
export function localClockTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso; // never fabricate a time — show the raw value
  }
  return parsed.toLocaleTimeString(undefined, { hour12: false });
}

/** Local calendar date — a UTC date sliced raw can be a day off. */
export function localDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleDateString();
}

/** Full local date + time, for record metadata and drilldowns. */
export function localDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString(undefined, { hour12: false });
}
