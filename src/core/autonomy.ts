// The autonomy axis (principles 1/4/6): three stops, per-project, persistent.
// Pure — the daemon owns storage, the doctrine owns behavior text; this module
// owns the ladder itself and what each stop structurally forbids.
//
// The INVARIANTS the axis never touches, whatever the stop: ambiguity ALWAYS
// interrupts (no guess-and-flag), and anything touching main or any
// direction-level call (architecture, scope, dependencies) needs the user's
// explicit yes. Auto widens Darwin's hands over WORKERS, never over those.

export const AUTONOMY_MODES = ["interview", "default", "auto"] as const;

export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export function isAutonomyMode(value: unknown): value is AutonomyMode {
  return typeof value === "string" && (AUTONOMY_MODES as readonly string[]).includes(value);
}

/** Shift+Tab walks the ladder in order and wraps. */
export function cycleAutonomyMode(current: AutonomyMode): AutonomyMode {
  const index = AUTONOMY_MODES.indexOf(current);
  return AUTONOMY_MODES[(index + 1) % AUTONOMY_MODES.length] ?? "default";
}

/** The composer pill / picker label for each stop. */
export const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  interview: "Interview/Plan",
  default: "Default",
  auto: "Auto",
};

/**
 * Structural (hard) gating per mode, applied to the manager's allowlist on
 * every turn. Interview/Plan is the clarity phase: no new work starts — no
 * spawns, no resumes, no merges into anyone's checkout — while tending the
 * EXISTING fleet (steer/hold/stop) stays possible. Doctrine text is the soft
 * gate; this is the one a persuasive turn cannot talk its way past.
 */
export function deniedToolsForMode(mode: AutonomyMode): readonly string[] {
  if (mode === "interview") {
    return [
      "mcp__galapagos__spawn_worker",
      "mcp__galapagos__resume_worker",
      "mcp__galapagos__merge_worker",
    ];
  }
  return [];
}
