// Slash-command language shared by the composer and its unit tests. This file
// stays pure: it describes and parses commands, while the UI decides how an
// invocation maps onto GalapagOS APIs and navigation.

export type SlashCommandName =
  | "plan"
  | "status"
  | "workers"
  | "review"
  | "verify"
  | "compact"
  | "records"
  | "diff"
  | "debug"
  | "mode"
  | "interrupt"
  | "help";

export type SlashCommandDefinition = {
  name: SlashCommandName;
  aliases: readonly string[];
  description: string;
  argumentHint: string | null;
  popularity: number;
};

/** Deliberately limited to commands GalapagOS can perform honestly today. */
export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    name: "plan",
    aliases: [],
    description: "Switch Darwin to Interview/Plan mode, optionally with a task",
    argumentHint: "[task]",
    popularity: 120,
  },
  {
    name: "status",
    aliases: ["recap"],
    description: "Ask for a concise project, worker, evidence, and blocker update",
    argumentHint: null,
    popularity: 110,
  },
  {
    name: "workers",
    aliases: ["tasks"],
    description: "Open the worker mission-control board",
    argumentHint: null,
    popularity: 100,
  },
  {
    name: "review",
    aliases: [],
    description: "Ask Darwin for a critical review of current or named work",
    argumentHint: "[scope]",
    popularity: 90,
  },
  {
    name: "verify",
    aliases: ["test"],
    description: "Run and summarize deterministic checks for current or named work",
    argumentHint: "[scope]",
    popularity: 80,
  },
  {
    name: "compact",
    aliases: ["rebrief"],
    description: "Start a fresh manager session re-briefed from durable records",
    argumentHint: null,
    popularity: 70,
  },
  {
    name: "records",
    aliases: ["memory"],
    description: "Open the durable records browser",
    argumentHint: null,
    popularity: 60,
  },
  {
    name: "diff",
    aliases: ["changes"],
    description: "Ask Darwin to summarize unmerged changes, evidence, and risk",
    argumentHint: "[scope]",
    popularity: 50,
  },
  {
    name: "debug",
    aliases: [],
    description: "Diagnose an issue methodically and route the appropriate fix",
    argumentHint: "[issue]",
    popularity: 40,
  },
  {
    name: "mode",
    aliases: [],
    description: "Set Darwin's autonomy stop directly",
    argumentHint: "<interview|default|auto>",
    popularity: 30,
  },
  {
    name: "interrupt",
    aliases: ["stop"],
    description: "Interrupt Darwin's current manager turn",
    argumentHint: null,
    popularity: 20,
  },
  {
    name: "help",
    aliases: [],
    description: "Show every available GalapagOS command",
    argumentHint: null,
    popularity: 10,
  },
] as const;

export type SlashCommandUsage = Partial<Record<SlashCommandName, number>>;

export type SlashCommandInvocation = {
  command: SlashCommandDefinition;
  invokedAs: string;
  args: string;
};

export type SlashCommandExecutionResult = {
  /** True only when the command turned into a user prompt. */
  consumeAttachments?: boolean;
  /** Short composer-local acknowledgement or validation error. */
  message?: string;
  /** Keep the command text available when validation or execution failed. */
  keepDraft?: boolean;
};

export type SlashCommandParseResult =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "unknown"; name: string }
  | ({ kind: "command" } & SlashCommandInvocation);

/**
 * The menu exists only while the first token is being typed. Once arguments
 * begin, the command is already selected and the menu gets out of the way.
 */
export function slashMenuQuery(draft: string): string | null {
  if (!draft.startsWith("/")) {
    return null;
  }
  const token = draft.slice(1);
  if (/\s/.test(token)) {
    return null;
  }
  return token.toLowerCase();
}

export function parseSlashCommand(input: string): SlashCommandParseResult {
  if (!input.startsWith("/")) {
    return { kind: "none" };
  }
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(input.trimEnd());
  if (!match) {
    return input === "/" ? { kind: "incomplete" } : { kind: "unknown", name: input.slice(1) };
  }
  const invokedAs = (match[1] ?? "").toLowerCase();
  const command = SLASH_COMMANDS.find(
    (candidate) => candidate.name === invokedAs || candidate.aliases.includes(invokedAs),
  );
  if (!command) {
    return { kind: "unknown", name: invokedAs };
  }
  return {
    kind: "command",
    command,
    invokedAs,
    args: (match[2] ?? "").trim(),
  };
}

function matchQuality(command: SlashCommandDefinition, query: string): number | null {
  if (!query) {
    return 0;
  }
  if (command.name === query) {
    return 0;
  }
  if (command.name.startsWith(query)) {
    return 1;
  }
  if (command.aliases.some((name) => name === query)) {
    return 2;
  }
  if (command.aliases.some((name) => name.startsWith(query))) {
    return 3;
  }
  if (command.name.includes(query)) {
    return 4;
  }
  if (command.aliases.some((name) => name.includes(query))) {
    return 5;
  }
  if (command.description.toLowerCase().includes(query)) {
    return 6;
  }
  return null;
}

/**
 * Typed relevance wins while filtering. Within equally relevant results,
 * personal usage outranks the sensible first-run popularity order.
 */
export function rankSlashCommands(
  query: string,
  usage: SlashCommandUsage = {},
): SlashCommandDefinition[] {
  const normalized = query.trim().toLowerCase();
  const matches = SLASH_COMMANDS.flatMap((command) => {
    const quality = matchQuality(command, normalized);
    return quality === null ? [] : [{ command, quality }];
  });
  // Descriptions help natural discovery only when the token did not match a
  // command or alias. Otherwise they add noisy, surprising rows.
  const relevant = matches.some((entry) => entry.quality < 6)
    ? matches.filter((entry) => entry.quality < 6)
    : matches;
  return relevant
    .sort((a, b) => {
      if (a.quality !== b.quality) {
        return a.quality - b.quality;
      }
      const used = (usage[b.command.name] ?? 0) - (usage[a.command.name] ?? 0);
      if (used !== 0) {
        return used;
      }
      return b.command.popularity - a.command.popularity;
    })
    .map(({ command }) => command);
}

export function slashCommandAutofill(command: SlashCommandDefinition): string {
  return `/${command.name}${command.argumentHint ? " " : ""}`;
}

export function recordSlashCommandUse(
  usage: SlashCommandUsage,
  name: SlashCommandName,
): SlashCommandUsage {
  return { ...usage, [name]: (usage[name] ?? 0) + 1 };
}

/** Prompt-backed commands remain ordinary, visible user turns. */
export function slashCommandPrompt(invocation: SlashCommandInvocation): string | null {
  const scope = invocation.args || "the current unmerged work";
  switch (invocation.command.name) {
    case "status":
      return "Give me a concise current project status: active work, completed-but-unmerged work, verification evidence, blockers, and the next decision I need to make.";
    case "review":
      return `Critically review ${scope}. Check behavior, architecture fit, failure paths, evidence, and gaps before recommending whether it is ready.`;
    case "verify":
      return `Verify ${scope} with the available deterministic checks and direct evidence. Report exactly what ran, what passed, what could not be observed, and any blocker.`;
    case "diff":
      return `Summarize the unmerged changes for ${scope} in product terms, then identify the highest-risk areas and the evidence supporting them.`;
    case "debug":
      return invocation.args
        ? `Diagnose this issue methodically and route the appropriate fix: ${invocation.args}`
        : "Help me diagnose the current issue methodically. Establish reproduction and root cause before routing a fix.";
    default:
      return null;
  }
}
