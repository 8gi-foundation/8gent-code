/**
 * The one list behind the local-first gate (scripts/local-first-gate.ts).
 *
 * Principle 2 of this repo: free and local by default. Nothing that sends the
 * person's data (audio, prompts, files, keys, usage) to someone else's machine
 * may be on by default, and anything that can must name its destination and need
 * a yes. The human-readable audit of this list is docs/security/off-device-data.md;
 * the gate fails when the two stop matching what the code does.
 *
 * Every host the shipped code mentions (packages/, apps/tui/, bin/) must be
 * covered by one entry here. An entry says what kind of reach it is:
 *
 *   optin    User data can leave, only after the person sets it up (a key, a
 *            token, a login, a mode). `optIn` names the guard that makes that
 *            true, as a regex that must still match in the named file: remove the
 *            guard and the gate fails. `files` (optional) are the only places
 *            allowed to reach it, so a new caller cannot skip the guard.
 *   command  User data can leave only when the person types a command that does
 *            exactly that (a search, an install). Not on any default path.
 *   default  User data can leave on a path nobody opted in to. Always a failure.
 *            Allowed to merge only with a `waiver`: a reference and an expiry, so
 *            it is a dated, linked, known item and never a quiet one.
 *   pull     A public download or version read. Sends no user content; the server
 *            sees an IP address and a client string.
 *   inert    Mentioned as a link, XML namespace, example or comment. Never
 *            requested by this code.
 *
 * Adding a sink: add one entry here, in the right mode, in the same PR as the
 * code, and say it in docs/security/off-device-data.md. Moving something from
 * optin to pull or inert is a claim a reviewer must read, not a formality.
 */

export type SinkMode = "optin" | "command" | "default" | "pull" | "inert";

export interface OptInGuard {
	/** Repo-relative file the guard lives in. */
	file: string;
	/** Must match that file's text. */
	mustMatch: RegExp;
	/** What the guard does, in words. */
	how: string;
}

export interface Waiver {
	/** An issue or PR that removes the item, e.g. "#4903". */
	ref: string;
	/** YYYY-MM-DD. After it, the waiver stops covering the item and the gate fails. */
	expires: string;
	why: string;
}

export interface Sink {
	id: string;
	/** What leaves the machine, and where it goes. */
	what: string;
	mode: SinkMode;
	/** Exact hostnames, or "*.suffix". */
	hosts?: string[];
	/** Reach with no hostname in the source (a phone service, an import). */
	patterns?: RegExp[];
	/** Where `hosts` and `patterns` may appear. A path ending "/" is a directory. Omit for any file. */
	files?: string[];
	optIn?: OptInGuard[];
	waiver?: Waiver;
}

/** Where the gate looks: what ships to a person's machine. */
export const SCOPE_DIRS = ["packages/", "apps/tui/", "bin/"];
export const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Tests, fixtures, type stubs, and the Convex backend (server side, with seed data of public links). */
export const EXCLUDED_PATH =
	/(^|\/)(node_modules|__tests__|__snapshots__|tests?|fixtures?|snapshots?|dist)\/|\.(test|spec)\.[a-z]+$|\.d\.ts$|^packages\/db\/convex\//i;
/** Hosts that are this machine or reserved for examples. Never off-device. */
export const LOCAL_HOST =
	/^(localhost|127\.|0\.0\.0\.0|\[?::1|example\.|.*\.example\.|.*\.invalid$)/i;

/** Registry names in packages/providers/index.ts that reach a hosted service. */
const HOSTED_MODEL_PROVIDERS = [
	"anthropic",
	"deepseek",
	"fireworks",
	"groq",
	"grok",
	"minimax",
	"mistral",
	"openai",
	"openrouter",
	"replicate",
	"together",
];

export const SINKS: Sink[] = [
	// --- voice -------------------------------------------------------------
	{
		id: "android-speech-service",
		what: "Microphone audio, heard by the phone's own speech recogniser through termux-speech-to-text. Android's SpeechRecognizer is often Google's cloud service, so the audio can leave the phone.",
		mode: "optin",
		patterns: [/termux-speech-to-text/],
		files: [
			"packages/eight/android-setup.ts",
			"packages/voice/termux-stt.ts",
			"packages/voice/termux.ts",
		],
		optIn: [
			{
				file: "packages/eight/android-setup.ts",
				// Either the speech-service question is reached only when the person typed
				// the command (mode "command"), or it is a separate cloud flag that
				// starts false and is asked only outside the first-launch pass (askCloud).
				mustMatch:
					/(?:mode\s*(?:!==|===)\s*"command"[\s\S]{0,400}?micAskLine\(|const none: SetupState = \{[^}]*cloud: false[^}]*\}[\s\S]*?mode === "auto"\) return[\s\S]*?askCloud\()/,
				how: "the off-device voice question is never asked on first launch, only after the person asks for voice",
			},
		],
		waiver: {
			ref: "#4903",
			expires: "2026-11-07",
			why: "The voice path moves to on-device whisper.cpp in 8TO's voice PR; until it lands, first launch still asks this question.",
		},
	},
	{
		id: "cloud-transcription",
		what: "Recorded speech sent to OpenAI's transcription API.",
		mode: "optin",
		hosts: ["api.openai.com"],
		files: [
			"packages/voice/cloud-transcriber.ts",
			"packages/providers/index.ts",
			"packages/gamedev/harness.ts",
		],
		optIn: [
			{
				file: "packages/voice/types.ts",
				mustMatch: /mode:\s*"local",/,
				how: 'voice mode defaults to local whisper.cpp; cloud needs setMode("cloud") and OPENAI_API_KEY',
			},
			{
				file: "packages/voice/cloud-transcriber.ts",
				mustMatch: /isCloudAvailable[\s\S]{0,200}OPENAI_API_KEY/,
				how: "no key, no cloud call",
			},
		],
	},

	// --- models ------------------------------------------------------------
	{
		id: "hosted-model-providers",
		what: "Prompts, tool results and images sent to a hosted model provider the person gave a key for.",
		mode: "optin",
		hosts: [
			"api.anthropic.com",
			"api.deepseek.com",
			"api.fireworks.ai",
			"api.groq.com",
			"api.minimax.io",
			"api.minimaxi.com",
			"api.mistral.ai",
			"api.replicate.com",
			"api.together.xyz",
			"api.x.ai",
			"api.openrouter.ai",
			"openrouter.ai",
		],
		files: [
			"apps/tui/src/",
			"packages/ai/",
			"packages/ci/review.ts",
			"packages/daemon/model-resolver.ts",
			"packages/eight/",
			"packages/g8way/",
			"packages/kernel/",
			"packages/music/replicate.ts",
			"packages/orchestration/sequential-pipeline.ts",
			"packages/providers/",
			"packages/secrets/index.ts",
			"packages/self-autonomy/local-servers.ts",
			"packages/settings/defaults.ts",
		],
		optIn: [
			{
				file: "packages/eight/clients/openrouter.ts",
				mustMatch: /nothing was sent to the hosted endpoint/,
				how: "a hosted endpoint with no key gets no request",
			},
			...HOSTED_MODEL_PROVIDERS.map((n) => ({
				file: "packages/providers/index.ts",
				mustMatch: new RegExp(`name:\\s*"${n}"[\\s\\S]{0,900}?enabled:\\s*false`),
				how: `${n} is off until a key is set`,
			})),
			{
				file: "packages/providers/index.ts",
				mustMatch: /PROVIDERS_ALLOW_HOST_CLI !== "1"\) return false/,
				how: "another company's command-line tool is never a provider unless PROVIDERS_ALLOW_HOST_CLI=1",
			},
		],
	},
	{
		id: "ollama-cloud",
		what: "Prompts sent to ollama.com when a model tag ending -cloud or :cloud is used. Ollama's own daemon forwards them unless started with OLLAMA_NO_CLOUD=1.",
		mode: "optin",
		patterns: [/EIGHT_OLLAMA_CLOUD/],
		files: ["packages/core/ollama-cloud.ts"],
		optIn: [
			{
				file: "packages/core/ollama-cloud.ts",
				mustMatch: /ollamaCloudAllowed[\s\S]{0,200}EIGHT_OLLAMA_CLOUD/,
				how: "EIGHT_OLLAMA_CLOUD=1 is the only way a cloud tag is picked or used",
			},
			{
				file: "packages/eight/clients/ollama.ts",
				mustMatch: /assertOllamaLocal\(this\.model\)[\s\S]{0,2000}assertOllamaLocal\(this\.model\)/,
				how: "the Ollama client refuses a cloud tag in chat and generate before sending",
			},
			{
				file: "packages/local-model-server/ollama.ts",
				mustMatch: /dropOllamaCloud\(/,
				how: "the model list every picker reads has cloud tags removed",
			},
		],
	},
	{
		id: "shared-judge-host",
		what: "Risky shell commands sent to the judge model on the host named in EIGHT_DECIDE_OLLAMA_HOST (default: this machine).",
		mode: "optin",
		hosts: ["ai-gateway.vercel.sh"],
		files: ["packages/decide/backends/jev.ts"],
		optIn: [
			{
				file: "packages/decide/backends/jev.ts",
				mustMatch: /if \(!opts\.apiKey\) throw new DecideUnavailableError/,
				how: "the hosted evaluator needs AI_GATEWAY_API_KEY",
			},
		],
	},
	{
		id: "8gent-account",
		what: "Sign-in and model-proxy traffic to 8gent services, only after the person signs in.",
		mode: "optin",
		hosts: ["8gent.app", "clerk.8gent.app", "8gentos.com", "8gi-model-proxy.fly.dev"],
		files: [
			"apps/tui/src/",
			"packages/ai/providers.ts",
			"packages/auth/",
			"packages/eight/",
			"packages/g8way/",
			"packages/kernel/judge.ts",
			"packages/providers/index.ts",
		],
		patterns: [/proxy-provider/],
		optIn: [],
	},
	{
		id: "fleet-internal",
		what: "Fleet vessels talking to the model proxy and board plane over the private network. Names that do not resolve from a person's machine.",
		mode: "command",
		hosts: ["8gi-model-proxy.internal", "8gi-board-plane.internal"],
		files: ["packages/board-vessel/", "packages/orchestration/sequential-pipeline.ts"],
	},

	// --- tools the model can call -----------------------------------------
	{
		id: "web-search",
		what: "The search words the model writes, sent to DuckDuckGo. The model can call web_search with no prompt to the person, and the tool is in the auto-allowed read-only set.",
		mode: "default",
		hosts: ["html.duckduckgo.com"],
		files: ["packages/tools/web.ts", "packages/tools/browser/web-search.ts"],
		waiver: {
			ref: "#4912",
			expires: "2026-11-07",
			why: "Decision needed from 8PO and James: web_search on by default, or behind a one-time yes that names DuckDuckGo. Tracked in docs/security/off-device-data.md.",
		},
	},

	// --- messaging and services, each behind a token ----------------------
	{
		id: "chat-and-mail-bridges",
		what: "Messages and replies sent to Telegram, Slack, Discord or Resend, only after the person sets that service's token.",
		mode: "optin",
		hosts: ["api.telegram.org", "slack.com", "discord.com", "gateway.discord.gg", "api.resend.com"],
		files: [
			"packages/ai/post-message.ts",
			"packages/board-plane/",
			"packages/daemon/",
			"packages/hooks/defaults.ts",
			"packages/telegram-bot/",
			"packages/telegram/",
			"packages/tools/actuators/notify.ts",
		],
		optIn: [
			{
				file: "packages/hooks/defaults.ts",
				mustMatch: /Telegram Notification[\s\S]{0,700}enabled:\s*false/,
				how: "the default Telegram hook ships disabled",
			},
		],
	},
	{
		id: "github-api",
		what: "Issues, pull requests and searches against the GitHub API, with the person's GitHub token.",
		mode: "optin",
		hosts: ["api.github.com"],
		files: [
			"packages/auth/",
			"packages/eight/self-update.ts",
			"packages/proactive/opportunity-scanner.ts",
			"packages/telegram-bot/intelligence.ts",
			"packages/threat-feed/inventory.ts",
		],
		optIn: [
			{
				file: "packages/eight/update-notice.ts",
				mustMatch: /launch update check is opt-in/,
				how: "the launch update check runs only with EIGHT_UPDATE_CHECK=1",
			},
		],
	},
	{
		id: "vercel-and-travel-apis",
		what: "Deploy and travel-search requests, with the person's own API key.",
		mode: "optin",
		hosts: ["api.vercel.com", "api.letsfg.co"],
		files: ["packages/tools/vercel.ts", "packages/travel/letsfg-provider.ts"],
		optIn: [
			{
				file: "packages/travel/letsfg-provider.ts",
				mustMatch: /LETSFG_API_KEY is required/,
				how: "no key, no request",
			},
		],
	},
	{
		id: "threat-feed",
		what: "Package names and versions from the person's lockfiles, sent to OSV, plus public CISA and CIRCL feed reads. Runs only from the threat-feed command.",
		mode: "command",
		hosts: ["api.osv.dev", "osv.dev", "www.cisa.gov", "www.circl.lu"],
		files: ["packages/threat-feed/"],
		patterns: [/threat-feed\/(feeds|inventory|match|issues)/],
	},
	{
		id: "dj-radio-search",
		what: "The station search word typed into /dj, sent to the Radio Browser directory.",
		mode: "command",
		hosts: ["de1.api.radio-browser.info"],
		files: ["packages/music/dj.ts"],
	},
	{
		id: "db-convex",
		what: "Records sent to a Convex deployment, only when a deployment URL is configured.",
		mode: "optin",
		hosts: ["*.convex.cloud"],
		files: ["packages/db/client.ts"],
		optIn: [
			{
				file: "packages/db/client.ts",
				mustMatch: /No CONVEX_URL configured\. Running in offline mode/,
				how: "no URL, offline mode",
			},
		],
	},

	// --- downloads (no user content) --------------------------------------
	{
		id: "downloads",
		what: "Installers, model weights and package metadata the person asked for.",
		mode: "pull",
		hosts: [
			"bun.sh",
			"deb.nodesource.com",
			"nodejs.org",
			"huggingface.co",
			"registry.npmjs.org",
			"raw.githubusercontent.com",
			"github.com",
			"fonts.googleapis.com",
		],
	},

	// --- links, namespaces, examples ---------------------------------------
	{
		id: "links",
		what: "Documentation links, XML namespaces and brand URLs. Never requested.",
		mode: "inert",
		hosts: [
			"8gent.dev",
			"bottosson.github.io",
			"dashboard.stripe.com",
			"docs.claude.com",
			"durable.com",
			"invisible-island.net",
			"iterm2.com",
			"learn.microsoft.com",
			"lmstudio.ai",
			"ollama.com",
			"pi.dev",
			"platform.deepseek.com",
			"purl.org",
			"python.org",
			"schemas.openxmlformats.org",
			"sox.sourceforge.net",
			"www.apple.com",
			"www.minimax.io",
			"vessel.fly.dev",
			"www.w3.org",
		],
	},
];

/**
 * A model is chosen automatically from Ollama's /api/tags, so a reader of that
 * list can pick a cloud tag. Every non-test file that reads it must go through
 * packages/core/ollama-cloud.ts, or be on this list: reviewed on 2026-10-24 as a
 * health check, a listing, a prefix match against a name 8gent already holds, or
 * a comment, and so never a way to choose a model by itself. A new reader fails
 * the gate until it does one or the other.
 */
export const OLLAMA_TAG_READERS_REVIEWED: Record<string, string> = {
	"bin/8gent.ts": "fast-mode prefix match against a local candidate name; doctor listing",
	"bin/debug.ts": "debug listing",
	"apps/tui/src/lib/model-selection.ts":
		"comment: describes the raw list the caller already filtered",
	"apps/tui/src/lib/provider-health.ts": "comment: health probe",
	"apps/tui/src/lib/provider-readiness.ts": "reachability probe of /api/tags",
	"packages/ai/edge-inference.ts": "embedding model presence check (a name 8gent holds)",
	"packages/ai/providers.ts": "reachability probe",
	"packages/board-vessel/vessel.ts": "waits for Ollama to answer",
	"packages/decide/index.ts": "comment",
	"packages/eight/judge-install.ts": "reachability probe; pulls a fixed judge model",
	"packages/eight/repl.ts": "fast-mode prefix match; /models listing",
	"packages/harness-cli/commands/doctor.ts": "doctor listing",
	"packages/kernel/proxy.ts": "health probe",
	"packages/local-model-server/model-ledger.ts": "digest of a model the person already has",
	"packages/local-model-server/server.ts": "comment",
	"packages/orchestration/local-model-detect.ts":
		"comment; list comes from listModels, filtered at source",
	"packages/memory/embeddings.ts": "embedding model presence check (a name 8gent holds)",
	"packages/providers/declared.ts": "discovery goes through dropOllamaCloudNames for ollama compat",
	"packages/self-autonomy/onboarding.ts": "comment; list comes from listModels, filtered at source",
	"packages/table/discovery.ts": "lists a host's models for display",
	"packages/telegram-bot/agent-mode.ts": "status listing",
};

// ---------------------------------------------------------------------------
// Rule 2: one install, zero deps.
//
// Core works after one install. A default code path must never require or run a
// system package install, and must never tell the person to run one: pkg, apt,
// brew, pip install, npm i -g (other than ourselves), ollama pull or serve, a
// cmake or make build. Allowed only behind an explicit opt-in or as a fallback
// after the person asked for a feature that needs it.
//
// A line that matches INSTALL_PATTERNS must be in one of three states:
//   - marked: the line, or one of the 8 lines above it, carries
//     `local-first-gate: optin <why>` or `local-first-gate: fallback <why>`;
//   - in a file listed below as optin or fallback (reviewed, nothing on a default path);
//   - in a file listed below as default, with a waiver. Always a failure otherwise.
// Anything else is a new install sink and fails the gate.
// ---------------------------------------------------------------------------

export const INSTALL_PATTERNS: RegExp[] = [
	/\b(?:pkg|apt|apt-get|dnf|yum|pacman|apk|brew|choco|winget|scoop)\s+(?:install|i|add)\b/,
	/\b(?:pip3?|pipx|cargo|gem)\s+install\b|-m\s+pip\s+install\b/,
	/\bnpm\s+(?:i|install|add)\s+(?:-g|--global)\b|\bbun\s+(?:add|install)\s+-g\b/,
	/\bollama\s+(?:pull|serve|run)\b|api\/pull\b|\[\s*"serve"\s*\]/,
	/\bcmake\s+(?:-|\.)|\bmake\s+(?:-j\d*|install)\b|xcode-select\s+--install/,
	/\binstallPkgs\(|\["install",\s*"-y"/,
];
/** Installing 8gent itself is the one install. */
export const INSTALL_OWN = /8gent-code|\$\{spec\}|\$\{file\}/;
/** Run by a person's own command, not part of a default path. */
export const INSTALL_EXCLUDED_PATH = /(^|\/)scripts\//;
export const INSTALL_MARKER = /local-first-gate:\s*(?:optin|fallback)\b/;

export type InstallMode = "optin" | "fallback" | "default";

export interface InstallSite {
	file: string;
	/**
	 * optin: runs only after an explicit command or a typed yes.
	 * fallback: text shown only after the person asked for a feature that is missing something; nothing runs.
	 * default: on a path nobody asked for. Needs a waiver.
	 */
	mode: InstallMode;
	why: string;
	waiver?: Waiver;
}

const INSTALL_WAIVER: Waiver = {
	ref: "#4915",
	expires: "2026-11-07",
	why: "Core must work after one install. Each entry goes when its install or install text is gone from the default path.",
};

export const INSTALL_SITES: InstallSite[] = [
	// --- default paths: waived, dated, linked ------------------------------
	{
		file: "packages/eight/android-setup.ts",
		mode: "default",
		why: "first launch asks, default yes, to run pkg install for music, and the voice question installs termux-api",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "packages/eight/judge-install.ts",
		mode: "default",
		why: "first launch asks, default yes, to pull the judge model through Ollama, and says to run ollama serve",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "apps/tui/src/lib/no-provider-guidance.ts",
		mode: "default",
		why: "the no-provider screen tells the person to install Ollama and run ollama pull",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "apps/tui/src/app.tsx",
		mode: "default",
		why: "the no-model message tells the person to run ollama pull",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "bin/8gent.ts",
		mode: "default",
		why: "the no-model error tells the person to run ollama pull",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "packages/eight/index.ts",
		mode: "default",
		why: "the runtime-unreachable error tells the person to run ollama serve",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "packages/eight/repl.ts",
		mode: "default",
		why: "the Ollama-not-running warning tells the person to run ollama serve",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "packages/providers/model-reroute.ts",
		mode: "default",
		why: "the no-local-model error tells the person to run ollama pull",
		waiver: INSTALL_WAIVER,
	},
	{
		file: "packages/self-autonomy/onboarding.ts",
		mode: "default",
		why: "onboarding tells the person to brew install ollama and ollama pull",
		waiver: INSTALL_WAIVER,
	},

	// --- explicit command or typed yes -------------------------------------
	{
		file: "apps/tui/src/lib/external-agent-runner.ts",
		mode: "optin",
		why: "installs another company's command-line tool, only when the person picks that tool",
	},
	{
		file: "packages/music/dj.ts",
		mode: "optin",
		why: "/dj offers the player install and runs it only after the person says yes",
	},

	// --- fallback text, nothing runs ---------------------------------------
	{
		file: "bin/node-version.js",
		mode: "fallback",
		why: "Node is missing, before 8gent starts at all",
	},
	{
		file: "packages/ai/eyes-vision-provider.ts",
		mode: "fallback",
		why: "vision was requested and no model is available",
	},
	{
		file: "packages/ai/tools.ts",
		mode: "fallback",
		why: "the hands tool was called and cliclick is missing",
	},
	{
		file: "packages/daemon/service.ts",
		mode: "fallback",
		why: "the person asked for a background service and termux-services is missing",
	},
	{
		file: "packages/deck/reference-breakdown.ts",
		mode: "fallback",
		why: "the deck command needs ffmpeg",
	},
	{
		file: "packages/eight/term-tools.ts",
		mode: "fallback",
		why: "a tmux tool was called and tmux is missing",
	},
	{
		file: "packages/eight/tools.ts",
		mode: "fallback",
		why: "a vision tool was called and no local vision model is present",
	},
	{
		file: "packages/eight/vision-router.ts",
		mode: "fallback",
		why: "vision was requested and no model was found",
	},
	{
		file: "packages/hands/index.ts",
		mode: "fallback",
		why: "a click or drag was requested and cliclick is missing",
	},
	{
		file: "packages/harness-cli/commands/doctor.ts",
		mode: "fallback",
		why: "the doctor command names the fix for a service it found down",
	},
	{
		file: "packages/kernel/local-trainer.ts",
		mode: "fallback",
		why: "the training pipeline is off by default; this lists what it lacks when run",
	},
	{
		file: "packages/lsp/index.ts",
		mode: "fallback",
		why: "a language server was requested and is missing",
	},
	{
		file: "packages/terminal-tab/pty-bridge.cjs",
		mode: "fallback",
		why: "the native terminal bridge failed to build",
	},
	{
		file: "packages/voice/backends/moshi-mlx.ts",
		mode: "fallback",
		why: "the Moshi backend was chosen and is missing",
	},
	{
		file: "packages/voice/index.ts",
		mode: "fallback",
		why: "voice input was requested and sox or whisper is missing",
	},
	{
		file: "packages/voice/input-device.ts",
		mode: "fallback",
		why: "voice input was requested and sox or whisper is missing",
	},
	{
		file: "packages/voice/recorder.ts",
		mode: "fallback",
		why: "recording was requested and sox is missing",
	},
	{
		file: "packages/voice/termux-stt.ts",
		mode: "fallback",
		why: "voice input was requested and termux-api is missing",
	},
	{
		file: "packages/voice/termux.ts",
		mode: "fallback",
		why: "spoken replies were requested and termux-api is missing",
	},
	{
		file: "packages/voice/voice-chat.ts",
		mode: "fallback",
		why: "voice chat was requested and whisper is missing",
	},
];
