/**
 * Voice Command Registry for Lil Eight
 *
 * Defines trigger phrases, handlers, and fuzzy matching for voice-driven
 * pet interactions. Extensible via plugin registration.
 */

// -- Types ------------------------------------------------------------------

export interface VoiceCommand {
  /** Unique identifier */
  id: string;
  /** Human-readable description */
  description: string;
  /** Phrases that activate this command (lowercase) */
  triggers: string[];
  /** Name of the handler function to invoke */
  handler: string;
  /** Optional plugin source that registered this command */
  source?: string;
}

export interface MatchResult {
  command: VoiceCommand;
  /** 0-1 confidence score */
  score: number;
  /** Extracted parameter from the input (e.g. app name, query text) */
  param?: string;
}

// -- Fuzzy matching ---------------------------------------------------------

/**
 * Levenshtein distance between two strings.
 * Used for fuzzy trigger matching.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Score how well `input` matches a trigger phrase.
 * Returns 0-1 where 1 is exact match. Handles parameterized
 * triggers like "open [app]" by extracting the parameter.
 */
function scoreTrigger(
  input: string,
  trigger: string,
): { score: number; param?: string } {
  const paramMatch = trigger.match(/^(.+?)\s*\[(\w+)]$/);

  if (paramMatch) {
    const prefix = paramMatch[1].trim();
    if (input.startsWith(prefix)) {
      const param = input.slice(prefix.length).trim();
      return { score: param.length > 0 ? 1.0 : 0.5, param };
    }
    const dist = levenshtein(input.split(" ")[0], prefix.split(" ")[0]);
    const maxLen = Math.max(input.split(" ")[0].length, prefix.split(" ")[0].length);
    const baseScore = maxLen > 0 ? 1 - dist / maxLen : 0;
    if (baseScore > 0.6) {
      const param = input.slice(input.indexOf(" ") + 1).trim();
      return { score: baseScore * 0.8, param };
    }
    return { score: 0 };
  }

  // Exact match
  if (input === trigger) return { score: 1.0 };

  // Fuzzy match on full string
  const dist = levenshtein(input, trigger);
  const maxLen = Math.max(input.length, trigger.length);
  const score = maxLen > 0 ? 1 - dist / maxLen : 0;
  return { score };
}

// -- Built-in commands ------------------------------------------------------

const BUILTIN_COMMANDS: VoiceCommand[] = [
  {
    id: "open-app",
    description: "Open an application by name",
    triggers: ["open [app]", "launch [app]", "start [app]"],
    handler: "handleOpenApp",
  },
  {
    id: "search",
    description: "Search the web or local files for a query",
    triggers: ["search [query]", "look up [query]", "find [query]"],
    handler: "handleSearch",
  },
  {
    id: "play-music",
    description: "Start playing music via the DJ power",
    triggers: ["play music", "play some music", "put on music", "play tunes"],
    handler: "handlePlayMusic",
  },
  {
    id: "what-time",
    description: "Report the current time",
    triggers: ["what time is it", "whats the time", "tell me the time", "current time"],
    handler: "handleWhatTime",
  },
  {
    id: "screenshot",
    description: "Capture a screenshot of the current screen",
    triggers: ["take a screenshot", "screenshot", "capture screen", "grab the screen"],
    handler: "handleScreenshot",
  },
  {
    id: "airdrop",
    description: "AirDrop the most recent file or screenshot",
    triggers: ["airdrop that", "airdrop it", "send via airdrop", "airdrop this"],
    handler: "handleAirdrop",
  },
  {
    id: "switch-language",
    description: "Switch Lil Eight's language",
    triggers: ["switch to [language]", "speak [language]", "change language to [language]"],
    handler: "handleSwitchLanguage",
  },
];

// -- Registry ---------------------------------------------------------------

export class VoiceCommandRegistry {
  private commands: VoiceCommand[] = [];
  /** Minimum score to consider a match */
  private threshold: number;

  constructor(threshold = 0.55) {
    this.threshold = threshold;
    this.commands = [...BUILTIN_COMMANDS];
  }

  /** Register a plugin command */
  register(command: VoiceCommand): void {
    if (this.commands.some((c) => c.id === command.id)) {
      throw new Error(`Voice command "${command.id}" already registered`);
    }
    this.commands.push(command);
  }

  /** Remove a command by id */
  unregister(id: string): boolean {
    const before = this.commands.length;
    this.commands = this.commands.filter((c) => c.id !== id);
    return this.commands.length < before;
  }

  /** Match user input against all registered commands */
  match(input: string): MatchResult | null {
    const normalized = input.toLowerCase().trim();
    let best: MatchResult | null = null;

    for (const cmd of this.commands) {
      for (const trigger of cmd.triggers) {
        const { score, param } = scoreTrigger(normalized, trigger);
        if (score >= this.threshold && (!best || score > best.score)) {
          best = { command: cmd, score, param };
        }
      }
    }

    return best;
  }

  /** List all registered commands */
  list(): ReadonlyArray<VoiceCommand> {
    return this.commands;
  }

  /** Number of registered commands */
  get size(): number {
    return this.commands.length;
  }
}
