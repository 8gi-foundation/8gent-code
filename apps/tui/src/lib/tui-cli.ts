/**
 * Parse argv for the Ink TUI entry (apps/tui/src/index.tsx).
 * Strips global flags so positional command defaults to `repl` when only flags are passed.
 */

export type ParsedTuiCli = {
  /** Non-flag tokens (e.g. subcommand for legacy slash flows) */
  positional: string[];
  sessionName?: string;
  sessionResume?: string;
  provider?: string;
  model?: string;
  yes: boolean;
  infiniteFlag: boolean;
};

function takeEqValue(arg: string, prefix: string): string | undefined {
  if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim() || undefined;
  return undefined;
}

export function parseTuiArgv(argv: string[]): ParsedTuiCli {
  const out: ParsedTuiCli = { positional: [], yes: false, infiniteFlag: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      out.yes = true;
      continue;
    }
    if (a === "--infinite" || a === "-infinite" || a === "-i") {
      out.infiniteFlag = true;
      continue;
    }
    if (a === "--no-pet" || a === "--pet" || a === "-pet") {
      continue;
    }
    const nameEq = takeEqValue(a, "--name=");
    if (nameEq !== undefined) {
      out.sessionName = nameEq;
      continue;
    }
    if (a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.sessionResume = next;
        i++;
      }
      continue;
    }
    const resumeEq = takeEqValue(a, "--resume=");
    if (resumeEq !== undefined) {
      out.sessionResume = resumeEq;
      continue;
    }
    const provEq = takeEqValue(a, "--provider=");
    if (provEq !== undefined) {
      out.provider = provEq;
      continue;
    }
    if (a === "--provider") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.provider = next;
        i++;
      }
      continue;
    }
    const modelEq = takeEqValue(a, "--model=");
    if (modelEq !== undefined) {
      out.model = modelEq;
      continue;
    }
    if (a === "--model") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.model = next;
        i++;
      }
      continue;
    }
    out.positional.push(a);
  }
  return out;
}
