/** Flatten to one line and truncate with an ellipsis — the app's one summary rule. */
export function oneLine(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
