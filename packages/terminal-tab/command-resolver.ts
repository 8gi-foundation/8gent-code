/**
 * @8gent/terminal-tab — command-resolver.ts
 *
 * Pure args-to-spawn resolver for /term. Decouples the slash-command
 * parser from the actual PTY spawn so the rules are testable in
 * isolation.
 *
 * Forms:
 *   /term                  → spawn the user's $SHELL interactively
 *   /term shell            → same as bare /term
 *   /term <preset>         → spawn a known external agent (claude, pi, …)
 *                            in interactive mode (no headless flags)
 *   /term <command...>     → spawn an arbitrary shell command via -c
 *
 * Preset → command mapping is data-only. The resolver does not import
 * the agent-runner registry; the caller passes a known-presets list so
 * tests stay hermetic.
 */

export interface ResolvedTermCommand {
	command: string;
	args: string[];
	label: string;
	/** Whether this resolved to a configured preset (vs raw / shell). */
	source: "shell" | "preset" | "raw";
}

export interface PresetEntry {
	id: string; // e.g. "claude"
	label: string; // e.g. "Claude Code"
	command: string; // e.g. "claude"
}

export interface ResolveOpts {
	/** Args after the `/term` keyword. May be empty. */
	args: string[];
	/** Known preset IDs the resolver can match against. */
	presets: readonly PresetEntry[];
	/** Defaults to process.env.SHELL || "/bin/zsh". */
	shell?: string;
}

const DEFAULT_SHELL = "/bin/zsh";

export function resolveTermCommand(opts: ResolveOpts): ResolvedTermCommand {
	const args = opts.args ?? [];
	const shell = opts.shell ?? process.env.SHELL ?? DEFAULT_SHELL;

	// /term  or  /term shell
	if (args.length === 0 || args[0]?.toLowerCase() === "shell") {
		return {
			command: shell,
			args: ["-i"],
			label: shellLabel(shell),
			source: "shell",
		};
	}

	const head = args[0];
	const rest = args.slice(1);

	const preset = opts.presets.find((p) => p.id.toLowerCase() === head.toLowerCase());
	if (preset && rest.length === 0) {
		// Bare preset → interactive mode, no headless flags.
		return {
			command: preset.command,
			args: [],
			label: preset.label,
			source: "preset",
		};
	}

	// Raw command (everything after /term).  Routed through the user's
	// shell with -c so quoting/expansion behaves like a normal CLI.
	const joined = args.join(" ");
	return {
		command: shell,
		args: ["-c", joined],
		label: truncateLabel(joined, 40),
		source: "raw",
	};
}

function shellLabel(shell: string): string {
	const base = shell.split("/").pop() ?? shell;
	return `Terminal (${base})`;
}

function truncateLabel(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}
