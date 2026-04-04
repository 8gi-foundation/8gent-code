export type SlashCommand =
	| "help"
	| "kanban"
	| "predict"
	| "avenues"
	| "clear"
	| "quit"
	| "plan"
	| "status"
	| "model"
	| "provider"
	| "voice"
	| "language"
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
	| "resume"
	| "history"
	| "continue"
	| "compact"
	| "chat"
	| "agent"
	| "github"
	| "debug"
	| "music"
	| "dj"
	| "pet"
	| "export"
	| "fork"
	| "branch"
	| "cron"
	| "deploy"
	| "vercel"
	| "telegram"
	| "router"
	| "rename";

export interface BuiltInSlashCommandDef {
	name: SlashCommand;
	aliases: string[];
	description: string;
	usage?: string;
}

export const BUILT_IN_SLASH_COMMANDS: BuiltInSlashCommandDef[] = [
	{ name: "help", aliases: ["h", "?"], description: "Show available commands" },
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
		name: "voice",
		aliases: ["v"],
		description: "Voice TTS settings",
		usage: "/voice [on|off|test]",
	},
	{
		name: "language",
		aliases: ["lang", "l"],
		description: "Set response language",
		usage: "/language [code]",
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
		usage:
			"/dj [play|radio|produce|pause|stop|skip|np|vol|loop|queue|dl|bpm|mix]",
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
		description: "Export current session as self-contained HTML",
		usage: "/export",
	},
	{
		name: "fork",
		aliases: ["f"],
		description: "Fork conversation at current message",
		usage: "/fork [label]",
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
		description: "Resume a recent session (pick from last 5)",
		usage: "/resume",
	},
	{
		name: "session",
		aliases: ["sess"],
		description: "Named session management (name, list, resume)",
		usage: "/session [name|list|resume] <args>",
	},
	{
		name: "history",
		aliases: ["hist", "sessions"],
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
		description: "Manage sub-agents (list, spawn, kill, auto, settings)",
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
];

export function getBuiltInSlashCommands(): BuiltInSlashCommandDef[] {
	return BUILT_IN_SLASH_COMMANDS;
}
