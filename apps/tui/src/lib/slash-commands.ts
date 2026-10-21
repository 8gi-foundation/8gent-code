export type SlashCommand =
	| "help"
	| "hotkeys"
	| "kanban"
	| "predict"
	| "avenues"
	| "clear"
	| "quit"
	| "plan"
	| "status"
	| "model"
	| "provider"
	| "apikeys"
	| "llama"
	| "route"
	| "privacy"
	| "models"
	| "voice"
	| "theme"
	| "reload"
	| "infinite"
	| "onboarding"
	| "preferences"
	| "skip"
	| "animations"
	| "adhd"
	| "quarantine"
	| "toolshed"
	| "skills"
	| "design"
	| "evidence"
	| "auth"
	| "vision"
	| "session"
	| "sessions"
	| "resume"
	| "history"
	| "continue"
	| "compact"
	| "update"
	| "chat"
	| "agent"
	| "github"
	| "debug"
	| "music"
	| "dj"
	| "pet"
	| "export"
	| "fork"
	| "rewind"
	| "branch"
	| "cron"
	| "deploy"
	| "vercel"
	| "telegram"
	| "router"
	| "rename"
	| "spawn"
	| "settings"
	| "quiet"
	| "term"
	| "create-app"
	| "hands"
	| "eyes"
	| "handeyes"
	| "goal"
	| "subgoal"
	| "build"
	| "notes"
	| "ideas"
	| "btw"
	| "questions"
	| "projects"
	| "terminal"
	| "copy"
	| "tree"
	| "import";

export interface BuiltInSlashCommandDef {
	name: SlashCommand;
	aliases: string[];
	description: string;
	usage?: string;
}

export const BUILT_IN_SLASH_COMMANDS: BuiltInSlashCommandDef[] = [
	{ name: "help", aliases: ["h", "?"], description: "Show available commands" },
	{
		name: "hotkeys",
		aliases: ["keys", "shortcuts"],
		description: "List every keyboard shortcut",
		usage: "/hotkeys",
	},
	{
		name: "kanban",
		aliases: ["k", "board"],
		description: "Toggle kanban board view",
	},
	{
		name: "predict",
		aliases: ["p", "next"],
		description: "Show predicted next steps",
	},
	{
		name: "apikeys",
		aliases: ["apikey"],
		description: "Enter or remove provider API keys (masked, kept in the OS keychain)",
		usage: "/apikeys",
	},
	{
		name: "avenues",
		aliases: ["a", "paths"],
		description: "Show all planned avenues",
	},
	{ name: "plan", aliases: ["pl"], description: "Show current execution plan" },
	{ name: "clear", aliases: ["cls", "c"], description: "Clear the screen" },
	{ name: "status", aliases: ["s", "st"], description: "Show session status" },
	{ name: "quit", aliases: ["q", "exit"], description: "Exit 8gent Code" },
	{
		name: "model",
		aliases: ["m"],
		description: "Select LLM model (↑↓ to scroll)",
		usage: "/model [name]",
	},
	{
		name: "provider",
		aliases: ["pr"],
		description: "Select LLM provider (↑↓ to scroll)",
		usage: "/provider [name]",
	},
	{
		name: "llama",
		aliases: [],
		description:
			"Takes status, load <id> or unload <id>: local llama-server health, loaded models, metrics",
		usage: "/llama [status|load <id>|unload <id>]",
	},
	{
		name: "route",
		aliases: [],
		description: "Takes local-only, local-first or cloud-first: where model calls may go",
		usage: "/route [local-only|local-first|cloud-first]",
	},
	{
		name: "consult",
		aliases: [],
		description:
			"Takes a question: one stateless question to your cloud model with secrets and personal data masked first",
		usage: "/consult <question>",
	},
	{
		name: "privacy",
		aliases: [],
		description: "How much stayed on this machine today and this session, and each cloud call",
		usage: "/privacy",
	},
	{
		name: "models",
		aliases: [],
		description:
			"Takes list or use <id>: llama-server models, switch model and keep the conversation",
		usage: "/models [list|use <id>]",
	},
	{
		name: "voice",
		aliases: ["v"],
		description: "Voice TTS settings",
		usage: "/voice [on|off|test]",
	},
	{
		name: "theme",
		aliases: ["t"],
		description: "Pick a TUI theme (built in or your own), or set light / dark / auto",
		usage: "/theme [name|default|status|light|dark|auto]",
	},
	{
		name: "reload",
		aliases: [],
		description: "Re-read your theme files from ~/.8gent/themes",
		usage: "/reload",
	},
	{
		name: "infinite",
		aliases: ["inf", "∞"],
		description: "Enable infinite mode (autonomous until done)",
		usage: "/infinite [task]",
	},
	{
		name: "onboarding",
		aliases: ["onboard", "setup", "intro"],
		description: "Start or restart personalization setup",
		usage: "/onboarding",
	},
	{
		name: "preferences",
		aliases: ["prefs", "settings"],
		description: "View or edit your preferences",
		usage: "/preferences [category]",
	},
	{
		name: "skip",
		aliases: ["later"],
		description: "Skip current onboarding question",
		usage: "/skip [all]",
	},
	{
		name: "animations",
		aliases: ["anim", "fx"],
		description: "Preview ASCII animations",
		usage: "/animations [matrix|fire|dna|stars|dots|glitch|confetti|wave|all]",
	},
	{
		name: "adhd",
		aliases: ["focus"],
		description: "ADHD mode - text + audio focus toolkit",
		usage: "/adhd [on|off|lofi|rainsound|whitenoise|ambient|classical|stop]",
	},
	{
		name: "music",
		aliases: ["audio", "soundscape"],
		description: "Generate & play focus music (ACE-Step)",
		usage: "/music [lofi|rain|white|ambient|piano|gen <prompt>|stop|config]",
	},
	{
		name: "dj",
		aliases: ["play", "radio"],
		description: "DJ Eight - YouTube, radio, produce, mix",
		usage: "/dj [play|radio|produce|pause|stop|skip|np|vol|loop|queue|dl|bpm|mix]",
	},
	{
		name: "pet",
		aliases: ["companion", "lileight"],
		description: "Spawn Lil Eight dock companion + show companion card",
		usage: "/pet [start|stop|deck|card]",
	},
	{
		name: "export",
		aliases: ["save"],
		description: "Export the session: <file>.jsonl for the session file, else HTML",
		usage: "/export [file.jsonl]",
	},
	{
		name: "import",
		aliases: [],
		description: "Import a session file written by /export <file>.jsonl",
		usage: "/import <file.jsonl>",
	},
	{
		name: "tree",
		aliases: [],
		description: "The session tree: pick any earlier message and continue from it",
		usage: "/tree",
	},
	{
		name: "fork",
		aliases: ["f"],
		description: "Copy the conversation so far into a new session and continue there",
		usage: "/fork [name]",
	},
	{
		name: "rewind",
		aliases: ["rw"],
		description: "Time-travel: rewind 8gent state to an earlier checkpoint",
		usage: "/rewind [n|list]",
	},
	{
		name: "branch",
		aliases: ["branches", "br"],
		description: "List or switch branches",
		usage: "/branch [list|switch <id>]",
	},
	{
		name: "cron",
		aliases: ["jobs", "schedule"],
		description: "Manage scheduled cron jobs",
		usage: "/cron [list|add|remove|enable|disable]",
	},
	{
		name: "deploy",
		aliases: ["redeploy"],
		description: "Trigger Vercel deploy of current project",
		usage: "/deploy",
	},
	{
		name: "vercel",
		aliases: ["vc"],
		description: "Vercel deployment management",
		usage: "/vercel [status|env|logs|projects|domains]",
	},
	{
		name: "router",
		aliases: ["route", "routing"],
		description: "Task router - assign models to task categories",
		usage: "/router [on|off|set|test|stats|status]",
	},
	{
		name: "quarantine",
		aliases: ["quar", "sandbox"],
		description: "Manage skill quarantine (add, scan, release, reject)",
		usage: "/quarantine [add|scan|list|release|reject] [args]",
	},
	{
		name: "toolshed",
		aliases: ["shed", "tools"],
		description: "Query available tools and capabilities",
		usage: "/toolshed [list|search|stats]",
	},
	{
		name: "skills",
		aliases: ["sk"],
		description: "List and manage skills",
		usage: "/skills [list|search|info] [name]",
	},
	{
		name: "design",
		aliases: ["d", "ui", "style"],
		description: "Suggest design systems for current task",
		usage: "/design [task description]",
	},
	{
		name: "build",
		aliases: ["b"],
		description: "Run the adaptive three-model pipeline on a build task",
		usage: "/build <task description>",
	},
	{
		name: "evidence",
		aliases: ["ev", "proof"],
		description: "Show full evidence breakdown for this session",
		usage: "/evidence",
	},
	{
		name: "auth",
		aliases: ["login", "account"],
		description: "Authentication (login, logout, status)",
		usage: "/auth [login|logout|status]",
	},
	{
		name: "github",
		aliases: ["gh"],
		description: "GitHub integration (issues, PRs, repos)",
		usage: "/github [issues|pr|repos|status]",
	},
	{
		name: "debug",
		aliases: ["inspect", "logs"],
		description: "Session debugger (sessions, health, tools, errors)",
		usage: "/debug [sessions|health|tools|errors|inspect <id>|export <id>]",
	},
	{
		name: "vision",
		aliases: ["vis", "ocr", "eye"],
		description: "Vision & OCR model settings",
		usage: "/vision [status|model|ocr|pull] [args]",
	},
	{
		name: "resume",
		aliases: ["res"],
		description: "Resume a session: searchable picker, or /resume <id or name>",
		usage: "/resume [id|name]",
	},
	{
		name: "session",
		aliases: ["sess"],
		description: "Named session management (name, list, resume)",
		usage: "/session [name|list|resume] <args>",
	},
	{
		name: "sessions",
		aliases: ["shared"],
		description: "Live and past shared sessions (join from the TUI or the 8gent Browser panel)",
		usage: "/sessions [share|attach <id>|stop|detach]",
	},
	{
		name: "history",
		aliases: ["hist"],
		description: "Browse all past sessions",
		usage: "/history",
	},
	{
		name: "continue",
		aliases: ["cont", "last"],
		description: "Continue most recent session automatically",
		usage: "/continue",
	},
	{
		name: "update",
		aliases: ["upgrade"],
		description: "Update 8gent, then reopen this session on the new version",
		usage: "/update [--force]",
	},
	{
		name: "compact",
		aliases: ["compress", "summarize"],
		description: "Summarize and compress current conversation",
		usage: "/compact",
	},
	{
		name: "chat",
		aliases: ["talk"],
		description: "Toggle chat mode (background work continues)",
		usage: "/chat",
	},
	{
		name: "agent",
		aliases: ["agents", "ag"],
		description: "Manage child 8gents (list, spawn, kill, auto, settings)",
		usage: "/agent [list|spawn|kill|auto|settings]",
	},
	{
		name: "telegram",
		aliases: ["tg"],
		description: "Telegram integration and setup",
		usage: "/telegram [status|setup]",
	},
	{
		name: "rename",
		aliases: ["ren"],
		description: "Rename current tab",
		usage: "/rename <new name>",
	},
	{
		name: "spawn",
		aliases: [],
		description:
			"Spawn an external 8gent CLI as a new tab (claude, codex, hermes, openclaw, pi, 8gent)",
		usage: "/spawn <claude|codex|hermes|openclaw|pi|8gent>",
	},
	{
		name: "settings",
		aliases: [],
		description: "Open settings view (toggle voice, performance, providers, models)",
		usage: "/settings",
	},
	{
		name: "quiet",
		aliases: ["mute", "shut", "silence"],
		description: "Stop the launch instrumental immediately (kills any in-flight intro music)",
		usage: "/quiet",
	},
	{
		name: "term",
		aliases: [],
		description:
			"Open a new PTY terminal tab. Bare /term or /term shell launches your $SHELL; /term <preset> launches an interactive 8gent CLI (claude, codex, hermes, openclaw, pi, 8gent); anything else is run via the shell.",
		usage: "/term [shell|<preset>|<command...>]",
	},
	{
		name: "create-app",
		aliases: ["new-app", "scaffold-app"],
		description:
			"Scaffold a personal mini-app at ~/.8gent/apps/<name>/ (manifest, index.ts, SKILL.md, tests). Iteration is driven by the embedded SKILL.md.",
		usage: "/create-app <name> [-- description text] [--caps read,write,bash]",
	},
	{
		name: "hands",
		aliases: [],
		description: "Toggle hands indicator (cliclick-driven cursor and keyboard).",
		usage: "/hands",
	},
	{
		name: "eyes",
		aliases: [],
		description: "Toggle eyes indicator (AX-bridge driven screen reads).",
		usage: "/eyes",
	},
	{
		name: "handeyes",
		aliases: [],
		description: "Toggle handeyes indicator (engagement loop, hands driven by eyes).",
		usage: "/handeyes",
	},
	{
		name: "goal",
		aliases: ["go"],
		description: "Run a goal to completion. Sub: status | stop | resume | clear | ?",
		usage: "/goal <goal> | /goal status | /goal stop | /goal resume | /goal clear | /goal ?",
	},
	{
		name: "subgoal",
		aliases: [],
		description: "Inject a sub-goal into the running /goal loop.",
		usage: "/subgoal <text>",
	},
	// Workspace tab commands. Each opens (or focuses) a utility tab; the
	// handlers live in app.tsx. They must be registered here or the slash
	// popup, the palette and /help never see them and the typed text is
	// sent to the model as chat.
	{
		name: "notes",
		aliases: [],
		description: "Open the Notes tab (scratchpad, Ctrl+N)",
		usage: "/notes",
	},
	{
		name: "ideas",
		aliases: [],
		description: "Open the Ideas tab (capture ideas as they come)",
		usage: "/ideas",
	},
	{
		name: "btw",
		aliases: [],
		description: "Open the BTW tab (park a side quest for later)",
		usage: "/btw",
	},
	{
		name: "questions",
		aliases: [],
		description: "Open the Questions tab (research questions to answer)",
		usage: "/questions",
	},
	{
		name: "projects",
		aliases: [],
		description: "Open the Projects tab (overview, switch working directory)",
		usage: "/projects",
	},
	{
		name: "terminal",
		aliases: [],
		description: "Open a terminal tab in the current project (optional tab label)",
		usage: "/terminal [label]",
	},
	{
		name: "copy",
		aliases: [],
		description: "Copy the last answer to the clipboard (works over SSH)",
		usage: "/copy",
	},
];

function getBuiltInSlashCommands(): BuiltInSlashCommandDef[] {
	return BUILT_IN_SLASH_COMMANDS;
}

/**
 * The commands about the work itself, few enough that a bare `/` shows every
 * one without scrolling (the menu draws 14 rows). The `/` menu and the Ctrl+P palette show
 * these first (the `/` menu shows only these until a letter is typed); every
 * other command still runs when typed by name and appears once its prefix
 * matches (#3918, Pi gap D9).
 */
export const CORE_SLASH_COMMANDS: ReadonlySet<SlashCommand> = new Set<SlashCommand>([
	"help",
	"model",
	"provider",
	"clear",
	"compact",
	"resume",
	"fork",
	"rewind",
	"export",
	"skills",
	"settings",
	"copy",
	"hotkeys",
	"quit",
]);

export function isCoreSlashCommand(name: SlashCommand): boolean {
	return CORE_SLASH_COMMANDS.has(name);
}

/** Built-in commands with the core ones first, each group in table order. */
export function builtInCommandsCoreFirst(
	commands: readonly BuiltInSlashCommandDef[] = BUILT_IN_SLASH_COMMANDS,
): BuiltInSlashCommandDef[] {
	return [
		...commands.filter((c) => isCoreSlashCommand(c.name)),
		...commands.filter((c) => !isCoreSlashCommand(c.name)),
	];
}

/** Mouse tips for /help: drag to select, and the terminal's own selection as a bypass. */
export const MOUSE_HELP =
	"Mouse: drag to select and copy, double click a word, triple click a line, Esc clears.\n  To use your terminal's own selection instead: Option-drag (iTerm2, Terminal.app), Shift-drag (most Linux terminals, Windows Terminal).";

/** The /help text. Core commands by default; `all` lists every built-in. */
export function formatSlashHelp(all: boolean): string {
	const rows = all
		? builtInCommandsCoreFirst()
		: BUILT_IN_SLASH_COMMANDS.filter((c) => isCoreSlashCommand(c.name));
	const lines = rows.map((c) => `  ${c.usage ?? `/${c.name}`} - ${c.description}`);
	const hidden = BUILT_IN_SLASH_COMMANDS.length - rows.length;
	const tail = all
		? "  /<skill> ... - Any loaded skill name or alias expands to its prompt\n  /<template> ... - A Markdown file in ~/.8gent/prompts, sent with $1, $@ filled in"
		: `  /help all - Show ${hidden} more commands`;
	return `${all ? "All commands" : "Core commands"}:\n${lines.join("\n")}\n${tail}\n${MOUSE_HELP}`;
}
