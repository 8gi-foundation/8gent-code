/**
 * Shell Autocomplete Generator for 8gent CLI
 *
 * Generates completion scripts for bash, zsh, and fish shells.
 * Completes subcommands, flags, and file paths.
 */

const SUBCOMMANDS: Record<string, string[]> = {
  tui: [],
  pet: [],
  chat: [],
  agent: ["list", "spawn", "kill", "message", "auto", "status"],
  session: ["list", "resume", "checkpoint", "compact"],
  preferences: ["get", "set", "sync", "reset"],
  memory: ["recall", "remember", "forget", "stats"],
  onboard: [],
  status: [],
  init: [],
  outline: [],
  symbol: [],
  search: [],
  benchmark: [],
  infinite: [],
  auth: ["login", "logout", "status"],
};

const GLOBAL_FLAGS = ["-h", "--help"];

const SESSION_FLAGS = ["--limit"];

function generateBash(): string {
  const cmds = Object.keys(SUBCOMMANDS).join(" ");
  const agentSubs = SUBCOMMANDS.agent.join(" ");
  const sessionSubs = SUBCOMMANDS.session.join(" ");
  const prefsSubs = SUBCOMMANDS.preferences.join(" ");
  const memorySubs = SUBCOMMANDS.memory.join(" ");
  const authSubs = SUBCOMMANDS.auth.join(" ");

  return `# 8gent bash completion - source this file or add to ~/.bashrc
_8gent_completions() {
  local cur prev cmds
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmds="${cmds}"

  case "\${prev}" in
    8gent)
      COMPREPLY=( $(compgen -W "\${cmds} ${GLOBAL_FLAGS.join(" ")}" -- "\${cur}") )
      return 0 ;;
    agent)
      COMPREPLY=( $(compgen -W "${agentSubs}" -- "\${cur}") ) ; return 0 ;;
    session)
      COMPREPLY=( $(compgen -W "${sessionSubs} ${SESSION_FLAGS.join(" ")}" -- "\${cur}") ) ; return 0 ;;
    preferences)
      COMPREPLY=( $(compgen -W "${prefsSubs}" -- "\${cur}") ) ; return 0 ;;
    memory)
      COMPREPLY=( $(compgen -W "${memorySubs}" -- "\${cur}") ) ; return 0 ;;
    auth)
      COMPREPLY=( $(compgen -W "${authSubs}" -- "\${cur}") ) ; return 0 ;;
    outline|symbol|search)
      COMPREPLY=( $(compgen -f -- "\${cur}") ) ; return 0 ;;
  esac

  # Default to file completion for unknown positions
  COMPREPLY=( $(compgen -f -- "\${cur}") )
}
complete -F _8gent_completions 8gent
`;
}

function generateZsh(): string {
  const cmds = Object.keys(SUBCOMMANDS)
    .map((c) => `'${c}:${c} command'`)
    .join("\n      ");

  return `#compdef 8gent
# 8gent zsh completion - place in fpath or source directly
_8gent() {
  local -a commands
  commands=(
      ${cmds}
  )

  _arguments -C \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case "\$state" in
    cmd)
      _describe 'command' commands ;;
    args)
      case "\${words[1]}" in
        agent)
          _values 'subcommand' ${SUBCOMMANDS.agent.join(" ")} ;;
        session)
          _values 'subcommand' ${SUBCOMMANDS.session.join(" ")}
          _arguments '--limit=[Limit results]:number' ;;
        preferences)
          _values 'subcommand' ${SUBCOMMANDS.preferences.join(" ")} ;;
        memory)
          _values 'subcommand' ${SUBCOMMANDS.memory.join(" ")} ;;
        auth)
          _values 'subcommand' ${SUBCOMMANDS.auth.join(" ")} ;;
        outline|symbol|search)
          _files ;;
        *)
          _files ;;
      esac ;;
  esac
}
_8gent "\$@"
`;
}

function generateFish(): string {
  const lines: string[] = [
    "# 8gent fish completion - place in ~/.config/fish/completions/8gent.fish",
    "# Disable file completions by default",
    "complete -c 8gent -f",
    "",
  ];

  // Top-level subcommands
  for (const cmd of Object.keys(SUBCOMMANDS)) {
    lines.push(
      `complete -c 8gent -n '__fish_use_subcommand' -a '${cmd}' -d '${cmd} command'`
    );
  }
  lines.push(
    `complete -c 8gent -n '__fish_use_subcommand' -s h -l help -d 'Show help'`
  );
  lines.push("");

  // Nested subcommands
  const nested: Record<string, string[]> = {
    agent: SUBCOMMANDS.agent,
    session: SUBCOMMANDS.session,
    preferences: SUBCOMMANDS.preferences,
    memory: SUBCOMMANDS.memory,
    auth: SUBCOMMANDS.auth,
  };

  for (const [parent, subs] of Object.entries(nested)) {
    for (const sub of subs) {
      lines.push(
        `complete -c 8gent -n '__fish_seen_subcommand_from ${parent}' -a '${sub}'`
      );
    }
  }
  lines.push("");

  // File path completion for file-accepting commands
  for (const cmd of ["outline", "symbol", "search"]) {
    lines.push(
      `complete -c 8gent -n '__fish_seen_subcommand_from ${cmd}' -F`
    );
  }

  return lines.join("\n") + "\n";
}

type Shell = "bash" | "zsh" | "fish";

export function generateCompletion(shell: Shell): string {
  switch (shell) {
    case "bash":
      return generateBash();
    case "zsh":
      return generateZsh();
    case "fish":
      return generateFish();
    default:
      throw new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
  }
}

// CLI entry point
if (import.meta.main) {
  const shell = (process.argv[2] ?? "bash") as Shell;
  if (!["bash", "zsh", "fish"].includes(shell)) {
    console.error(`Usage: bun run autocomplete.ts <bash|zsh|fish>`);
    process.exit(1);
  }
  console.log(generateCompletion(shell));
}
