// The four views. Every box and arrow names the repo path it was read from.
// Facts are from origin/main at the commit named in docs/architecture/README.md.

import { execSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scene } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

// ------------------------------------------------------------------ gaps
// One register, drawn red on views 1-3 and listed in view 4 and the README.
export const GAPS = [
	{
		id: "G01",
		cat: "platform",
		t: "Android/Termux daemon unverified (#4852)",
		ev: ["packages/daemon/service.ts:450-455", "scripts/smoke-termux.sh"],
		d: "service.ts refuses every platform except darwin, linux, win32, so a Termux user can only run `8gent daemon run` by hand. The Termux smoke job checks install, --version, TUI first frame and install.sh, never the daemon.",
	},
	{
		id: "G02",
		cat: "platform",
		t: "Fly eight-vessel runs board-vessel, not the daemon",
		ev: ["fly.toml", "Dockerfile", "scripts/board-vessel/entrypoint.sh:51-54"],
		d: "The root fly.toml app `eight-vessel` builds the root Dockerfile whose CMD is the board-vessel entrypoint (packages/board-vessel/vessel.ts). Nothing in the repo starts packages/daemon/index.ts on Fly, so 'the daemon runs on Fly' is unverified.",
	},
	{
		id: "G03",
		cat: "platform",
		t: "macOS launchd service never exercised in CI",
		ev: ["packages/daemon/service.e2e.test.ts:14-17", ".github/workflows/platforms.yml:24-29"],
		d: "The real-service e2e is disabled when process.platform is darwin and the Platforms matrix has only ubuntu-latest and windows-latest. The launchd plan is unit-tested as data only.",
	},
	{
		id: "G04",
		cat: "platform",
		t: "Three compiled targets have no smoke test",
		ev: ["scripts/build-binaries.ts:66-72", ".github/workflows/smoke-compiled.yml:28-35"],
		d: "darwin-x64, linux-arm64 and windows-x64-baseline are built and released but the compiled smoke matrix covers linux-x64, darwin-arm64 and windows-x64 only.",
	},
	{
		id: "G05",
		cat: "platform",
		t: "Swift apps have no release job",
		ev: [".github/workflows/swift-nightly.yml", ".github/workflows/release-binaries.yml"],
		d: "apps/8gent-computer and apps/lil-eight build in swift-nightly (8gent-computer) or by hand (lil-eight build.sh). No workflow in release.yml or release-binaries.yml builds, signs or attaches either app.",
	},
	{
		id: "G06",
		cat: "dead",
		t: "Dead or stub packages",
		ev: [
			"packages/dreams",
			"packages/qdrant-client/README.md",
			"packages/planner/index.ts",
			"packages/channels/index.ts",
			"packages/control-plane/index.ts",
			"packages/8dk/index.ts",
		],
		d: "dreams holds one markdown file and no code. qdrant-client is stubs that throw NotImplementedError. planner, channels, control-plane and 8dk have zero importers in packages, apps, bin, scripts and tests (channels appears only in a security fixture list).",
	},
	{
		id: "G07",
		cat: "dead",
		t: "packages/tools: 62 of 96 modules have no importer",
		ev: [
			"packages/tools/crc32.ts",
			"packages/tools/lru-cache.ts",
			"docs/architecture/evidence/tools-orphans.txt",
		],
		d: "Static grep of every top-level packages/tools/*.ts: 62 are imported by nothing (utility files such as crc32, bit-flags, moving-average, sqli-pattern-detector) and 60 of those have no test either. Full list in docs/architecture/evidence/tools-orphans.txt.",
	},
	{
		id: "G08",
		cat: "dead",
		t: "Orphan files inside packages/eight",
		ev: [
			"packages/eight/auto-commit.ts",
			"packages/eight/clui-bridge.ts",
			"packages/eight/curriculum.ts",
			"packages/eight/external-editor.ts",
		],
		d: "No importer outside tests for any of the four. clui-bridge.ts bridges to apps/clui, which does not exist on main.",
	},
	{
		id: "G09",
		cat: "untested",
		t: "Packages with source and zero tests",
		ev: [
			"packages/auth",
			"packages/quarantine",
			"packages/registry",
			"packages/hands",
			"packages/lsp",
			"packages/tasks",
			"packages/personality",
			"packages/design-agent",
			"packages/planning",
			"packages/executor",
			"packages/i18n",
			"packages/repo-context",
		],
		d: "auth (Clerk and GitHub token handling) and quarantine are the two that matter for security; hands drives the desktop with cliclick and osascript.",
	},
	{
		id: "G10",
		cat: "unread",
		t: "threat-feed is manual and its report is read by nobody",
		ev: ["packages/threat-feed/cli.ts", "packages/threat-feed/README.md"],
		d: "OSV and CISA KEV are queried only when someone runs the CLI. No workflow, cron entry or daemon job calls it (grep of .github, scripts, packages). Reports land in ~/.8gent/security/threat-feed/<date>/ with no reader.",
	},
	{
		id: "G11",
		cat: "unread",
		t: "Turn journal is written every turn, read only by a script",
		ev: ["packages/eight/turn-journal.ts:59", "scripts/turn-review-replay.ts"],
		d: "~/.8gent/turns/<session>/<n>.json has one reader, scripts/turn-review-replay.ts. No TUI view, daemon route or CLI subcommand reads it.",
	},
	{
		id: "G12",
		cat: "unread",
		t: "~/.8gent/evidence has no writer in the repo",
		ev: ["apps/tui/src/components/IntroBanner.tsx:2"],
		d: "The only mention in product code is a design-doc comment. Whatever fills the directory on a dev machine is outside the repo, so nothing in the code can promise it exists.",
	},
	{
		id: "G13",
		cat: "moving-parts",
		t: "Two cron schedulers share one cron.json",
		ev: ["packages/cron/index.ts:86", "packages/daemon/cron.ts:35", "bin/8gent.ts:137"],
		d: "The CLI and TUI use packages/cron, the daemon uses packages/daemon/cron.ts, both persist ~/.8gent/cron.json with their own code. Two writers, no shared lock.",
	},
	{
		id: "G14",
		cat: "unverified",
		t: "Convex backend is not in this repo",
		ev: ["apps/convex/_generated/api.ts", "packages/db/client.ts:63"],
		d: "apps/convex holds only _generated files. packages/db runs offline without CONVEX_URL. The schema and functions it talks to live elsewhere, so the sync path cannot be read here.",
	},
	{
		id: "G15",
		cat: "docs",
		t: "Docs name apps and counts the tree does not have",
		ev: ["README.md:608-609", "CLAUDE.md:21-22", "packages/providers/index.ts:274-577"],
		d: "README.md and CLAUDE.md list apps/clui and apps/dashboard, neither exists. CLAUDE.md says 11 providers and 'Apple Foundation is NOT wired'; the registry holds 20 entries and apple-foundation is wired (index.ts:340).",
	},
	{
		id: "G16",
		cat: "platform",
		t: "g8way has no deploy unit in infra",
		ev: ["packages/g8way/README.md", "infra/hetzner/docker-compose.yml"],
		d: "README says it runs on the Hetzner box behind Caddy, but docker-compose.yml and infra/hetzner/systemd carry only the daemon and two Telegram bridges. How g8way is deployed is not in the repo.",
	},
	{
		id: "G17",
		cat: "unverified",
		t: "'8gate' is not a module; 8J is opt-in behind g8way",
		ev: [
			"packages/eight/provider-choice.test.ts",
			"packages/g8way/README.md:50-75",
			"packages/decide/README.md:281-285",
		],
		d: "The name 8gate appears only in two test files. The shipped judge is Selene-1-Mini via packages/decide, on by default. 8J (HF Space 8GI/8j-eval) is reachable only through a g8way upstream with EIGHT_ALLOW_HOSTED=1.",
	},
	{
		id: "G18",
		cat: "unverified",
		t: "Stub web apps: root src/ and apps/debugger",
		ev: [
			"src/Counter.tsx",
			"src/app/icon.tsx",
			"apps/debugger/README.md",
			"package.json (dev: next dev)",
		],
		d: "The root `dev` script runs next dev over a three-file stub. apps/debugger's README is the create-next-app default, so its purpose is not stated in the repo.",
	},
	{
		id: "G19",
		cat: "moving-parts",
		t: "Four Telegram code paths",
		ev: [
			"packages/daemon/telegram-bridge.ts",
			"packages/telegram-bot/index.ts",
			"packages/telegram/index.ts",
			"apps/8gent-bot/src/index.ts",
		],
		d: "Each talks to api.telegram.org with its own client. The Hetzner units run the daemon bridge; the Fly app runs apps/8gent-bot; packages/telegram is imported by agent.ts and repl.ts.",
	},
];
const gap = (id) => GAPS.find((g) => g.id === id);
const gapBox = (sc, id, x, y, w) => {
	const g = gap(id);
	return sc.box(`gap_${id}`, {
		x,
		y,
		w,
		kind: "gap",
		title: `${id}  ${g.t}`,
		body: [g.ev.slice(0, 2).join(" ; ")],
		src: g.ev[0],
		tfs: 15,
		bfs: 12,
	});
};

// ------------------------------------------------------- package register
export const PKG_GROUPS = [
	[
		"Models and judges",
		[
			["local-model-server", "Ollama and llama.cpp layer"],
			["decide", "System One judge, calibrated"],
			["verify", "deterministic verify and turn review"],
			["providers", "20-entry registry, failover, PII gate"],
			["kernel", "RL fine-tune pipeline, off by default"],
			["g8way", "OpenAI-compatible proxy, Clerk JWT"],
			["qdrant-client", "stubs only", "gap"],
		],
	],
	[
		"Engine and loop",
		[
			["eight", "8gent loop; calls permissions, providers, memory, tools"],
			["core", "home, shell, path guards"],
			["types", "shared types, thinking levels"],
			["ai", "Vercel AI SDK wrap, task router"],
			["goal", "/go goal loop, judge, budget, receipt"],
			["harness", "meta-harness foundation"],
			["harness-cli", "headless run and sessions CLI"],
			["planning", "proactive planner, avenues"],
			["planner", "plan builder", "gap"],
			["executor", "autonomous task executor"],
			["tasks", "tasks.json tracker"],
			["proactive", "clarifying questions"],
			["i18n", "reply language"],
			["personality", "the Infinite Gentleman"],
			["infinite", "dangerously autonomous mode"],
			["workflow", "workflow exports"],
			["validation", "validation exports"],
			["settings", "typed ~/.8gent/settings.json store"],
		],
	],
	[
		"Safety and trust",
		[
			["permissions", "deny-by-default policy engine"],
			["secrets", "AES-256-GCM vault"],
			["quarantine", "trust no one"],
			["audit", "access audit log"],
			["auth", "Clerk, GitHub OAuth, tokens"],
			["threat-feed", "OSV and KEV report, manual", "gap"],
			["ci", "model-literal and review guards"],
		],
	],
	[
		"Memory and code intelligence",
		[
			["memory", "SQLite, FTS5, vectors, graph"],
			["ast-index", "symbol outline, locate, ripgrep"],
			["repo-context", "context selection"],
			["lsp", "language server client"],
			["db", "Convex client, workspace state.db"],
			["self-autonomy", "evolution, reflection, versioning"],
			["specifications", "schemas, session writer, durable ledger"],
			["dreams", "markdown only, no code", "gap"],
		],
	],
	[
		"Tools and extension",
		[
			["tools", "114 files, 62 orphans", "gap"],
			["toolshed", "skill registry, GitHub tools"],
			["skills", "markdown skills"],
			["extensions", "extension loader"],
			["mcp", "MCP client and server"],
			["hooks", "lifecycle hooks"],
			["marketplace", "app archive format"],
			["registry", "design primitives, installed apps"],
			["app-creator", "scaffolds apps, loaded from the TUI"],
		],
	],
	[
		"Fleet, channels and comms",
		[
			["orchestration", "worktrees, vessel mesh, delegation"],
			["daemon", "always-on process"],
			["cron", "CLI scheduler"],
			["board-plane", "control plane, Discord gateway"],
			["board-vessel", "officer vessel, Fly"],
			["control-plane", "Stripe billing, tenants", "gap"],
			["channels", "multi-platform router", "gap"],
			["table", "channels, members, signed ledger"],
			["8dk", "device kit, pairing", "gap"],
			["telegram", "Telegram command center"],
			["telegram-bot", "Telegram bot"],
			["flow", "flow-mode capture gate"],
			["telemetry", "per-tenant telemetry"],
			["reporting", "completion reports, runs.jsonl"],
		],
	],
	[
		"Body, voice and desktop",
		[
			["computer", "desktop automation"],
			["hands", "cliclick, osascript, screencapture"],
			["eyes", "perception, AX bridge"],
			["handeyes", "hands plus eyes"],
			["voice", "Whisper STT, TTS"],
			["music", "DJ via mpv and yt-dlp"],
			["terminal-tab", "terminal tabs"],
			["pet", "Lil Eight terminal pet"],
			["render", "Chrome render backend"],
		],
	],
	[
		"Media and design",
		[
			["deck", "Marp deck to video"],
			["film-craft", "film look, magick and ffmpeg"],
			["design-agent", "design suggestions"],
			["design-compose", "deterministic design specs"],
			["design-systems", "design system SQLite"],
			["gamedev", "2D game pipeline"],
			["travel", "LetsFG flight provider"],
		],
	],
	[
		"Runtime and install",
		[
			["install-runner", "one-yes installers"],
			["node-compat", "Bun shims for Node build"],
			["runtime", "managed Node 22 under ~/.8gent"],
		],
	],
];

// ------------------------------------------------------------ view 1
function systemMap() {
	const sc = new Scene(
		"01-system-map",
		"8gent-code: system map",
		"Entry points, apps, the daemon and how it runs per platform, and every package by role. Red dashed = gap, orange dashed = unverified. Source of every box: docs/architecture/README.md.",
	);
	const S = (id, o) => sc.box(id, o);

	// Column A: entry points
	const fE = sc.frame({
		x: -20,
		y: 0,
		w: 580,
		h: 1500,
		kind: "entry",
		title: "ENTRY POINTS AND DISTRIBUTION",
	});
	let y = 70;
	const entry = [
		[
			"e_npm",
			"npm package @8gi-foundation/8gent-code",
			[
				"package.json bin: 8, 8gent, 8gent-code -> bin/8gent-run.js",
				"ships dist/cli.js, dist/tui.js, dist/node/*",
			],
			"package.json",
		],
		[
			"e_run",
			"bin/8gent-run.js launcher",
			[
				"spawns bun dist/cli.js with an empty bunfig",
				"no Bun: node dist/node/cli.js (EIGHT_RUNTIME=node forces it)",
			],
			"bin/8gent-run.js",
		],
		[
			"e_cli",
			"bin/8gent.ts (CLI source)",
			[
				"tui, run, chat, daemon, cron, rpc, mcp-server, review, deck, bug, update, keys, permissions, memory, session",
			],
			"bin/8gent.ts",
		],
		[
			"e_bin",
			"Compiled binaries (6 targets)",
			[
				"scripts/build-binaries.ts: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-x64-baseline",
			],
			"scripts/build-binaries.ts",
		],
		[
			"e_inst",
			"scripts/install.sh (macOS, Linux)",
			[
				"fetches the binary from a GitHub Release",
				"minisign-checked SHA256SUMS, attestation check",
			],
			"scripts/install.sh",
		],
		[
			"e_ps1",
			"scripts/install.ps1 (Windows)",
			["Windows counterpart of install.sh"],
			"scripts/install.ps1",
		],
		[
			"e_pkg",
			"OS packages",
			[
				"packaging/linux/nfpm.yaml (deb, rpm)",
				"packaging/windows/installer.nsi",
				"packaging/winget/*.yaml",
			],
			"packaging",
		],
		[
			"e_termux",
			"Termux path (Android)",
			[
				"install.sh sees Android, installs the release npm .tgz with nodejs; no glibc binary",
				"bin/termux-exec.js LD_PRELOAD handoff, packages/eight/android-setup.ts",
				"TUI smoke exists; daemon UNVERIFIED",
			],
			"scripts/install.sh; bin/termux-exec.js; scripts/smoke-termux.sh",
		],
		[
			"e_gha",
			"Release pipeline",
			[
				".github/workflows/release.yml: GitHub Release + npm (trusted publisher)",
				"release-binaries.yml: build, sign, attest, smoke-termux",
			],
			".github/workflows/release.yml; .github/workflows/release-binaries.yml",
		],
		[
			"e_docker",
			"Dockerfile and infra/hetzner",
			["root Dockerfile = board vessel image", "infra/hetzner: daemon + two Telegram bridges"],
			"Dockerfile; infra/hetzner/docker-compose.yml",
		],
	];
	for (const [id, title, body, src] of entry) {
		const b = S(id, {
			x: 0,
			y,
			w: 520,
			title,
			body,
			src,
			kind: id === "e_termux" ? "unv" : "entry",
		});
		y += b.h + 22;
	}
	fE.h = y - 10;

	// Column B: apps
	const apps = [
		[
			"a_tui",
			"apps/tui (Ink)",
			[
				"src/index.tsx; chat, history, settings, terminal, music, notes screens",
				"reaches the daemon via lib/daemon-sessions.ts",
			],
			"apps/tui/src/index.tsx",
			"app",
		],
		[
			"a_comp",
			"apps/8gent-computer (Swift, macOS)",
			[
				"Cmd+Opt+Space voice computer-use",
				"ws://127.0.0.1:18789/computer",
				"built by build.sh and swift-nightly only",
			],
			"apps/8gent-computer/README.md",
			"app",
		],
		[
			"a_lil",
			"apps/lil-eight (Swift pet, macOS)",
			["build.sh -> Lil Eight.app", "npm scripts pet, pet:build, pet:open"],
			"apps/lil-eight/build.sh",
			"app",
		],
		[
			"a_bot",
			"apps/8gent-bot (Fly 8gi-orchestrator)",
			["Telegram orchestrator, routes to officer vessels"],
			"apps/8gent-bot/fly.toml",
			"app",
		],
		[
			"a_li",
			"apps/linkedin-vessel (Fly)",
			["LinkedIn outreach vessel, MCP server, campaign db"],
			"apps/linkedin-vessel/fly.toml",
			"app",
		],
		[
			"a_eyes",
			"apps/8gent-eyes (CLI)",
			["capture, find, describe, wait; --json default"],
			"apps/8gent-eyes/package.json",
			"app",
		],
		[
			"a_flow",
			"apps/8gent-flow",
			["Mac vision relay for flow clients (serve)"],
			"apps/8gent-flow/package.json",
			"app",
		],
		[
			"a_proxy",
			"apps/proxy",
			["OpenAI-compatible gateway on 127.0.0.1:8787 over the adaptive router"],
			"apps/proxy/README.md",
			"app",
		],
		[
			"a_dbg",
			"apps/debugger (Next.js)",
			["README is the create-next-app default; purpose unverified"],
			"apps/debugger/README.md",
			"unv",
		],
		[
			"a_vid",
			"apps/video (Remotion)",
			["compositions, travel map templates"],
			"apps/video/package.json",
			"app",
		],
		[
			"a_cvx",
			"apps/convex",
			["only _generated/api.ts and dataModel.ts"],
			"apps/convex/_generated/api.ts",
			"gap",
		],
		[
			"a_clui",
			"apps/clui, apps/dashboard",
			["named in README.md:608 and CLAUDE.md:21, absent from the tree"],
			"README.md:608-609",
			"gap",
		],
	];
	const fApps = sc.frame({ x: 620, y: 0, w: 800, h: 1100, kind: "app", title: "apps/*" });
	const gApps = sc.grid(640, 70, 2, 380, 20, 20, apps, (a, x, _y, w) =>
		S(a[0], { x, y: 0, w, title: a[1], body: a[2], src: a[3], kind: a[4], tfs: 16, bfs: 12 }),
	);

	fApps.h = gApps.y + gApps.h - fApps.y + 30;

	// Column C: daemon
	const fDm = sc.frame({
		x: 1480,
		y: 0,
		w: 1200,
		h: 1080,
		kind: "daemon",
		title: "packages/daemon (TypeScript on Bun, not Swift)",
		sub: "WebSocket + HTTP gateway on :18789. Started by `8gent daemon run`, the login service, or the Hetzner units.",
	});
	const dm = [
		[
			"d_gw",
			"gateway.ts",
			[
				"WebSocket and HTTP :18789",
				"/computer /dispatch /store /live/ws /health /ops/agent-pool/status /audit/access /harness",
			],
			"packages/daemon/gateway.ts:963-1106",
		],
		[
			"d_pool",
			"agent-pool.ts",
			["up to 10 sessions (MAX_SESSIONS), per-session work queue"],
			"packages/daemon/agent-pool.ts:95",
		],
		["d_cron", "cron.ts", ["~/.8gent/cron.json, restart catchup"], "packages/daemon/cron.ts:35"],
		[
			"d_hb",
			"heartbeat.ts",
			["periodic heartbeat run, emits on the event bus"],
			"packages/daemon/heartbeat.ts",
		],
		[
			"d_journal",
			"session-journal.ts",
			["EIGHT_RESUME_ON_BOOT: restore sessions from checkpoints"],
			"packages/daemon/session-journal.ts",
		],
		[
			"d_tg",
			"telegram-bridge.ts",
			["bot token + authorized chat ids, own daemon session over ws"],
			"packages/daemon/telegram-bridge.ts",
		],
		[
			"d_slack",
			"slack.ts",
			["posts via slack.com chat.postMessage"],
			"packages/daemon/slack.ts:138",
		],
		[
			"d_table",
			"table-routes.ts",
			["Table channels, signed ledger, loopback-only frames"],
			"packages/daemon/table-routes.ts",
		],
		["d_goal", "goal-rpc.ts", ["goal loop RPC, GoalManager"], "packages/daemon/goal-rpc.ts"],
		[
			"d_disp",
			"dispatch.ts",
			["surfaces, local token verifier, ledger, rate limiter"],
			"packages/daemon/dispatch.ts",
		],
		[
			"d_svc",
			"service.ts",
			["login-service plans: launchd, systemd --user, Scheduled Task"],
			"packages/daemon/service.ts:1-12",
		],
		[
			"d_mesh",
			"VesselMesh registration",
			["only when GROVE_ENABLED=1 and not local mode"],
			"packages/daemon/index.ts:477",
		],
	];
	const gDm = sc.grid(1500, 100, 3, 360, 20, 20, dm, (a, x, _y, w) =>
		S(a[0], { x, y: 0, w, title: a[1], body: a[2], src: a[3], kind: "daemon", tfs: 16, bfs: 12 }),
	);

	fDm.h = gDm.y + gDm.h - fDm.y + 30;
	// platform row (below the daemon boxes)
	const platY = fDm.y + fDm.h + 40;
	const fPlat = sc.frame({
		x: 1480,
		y: platY,
		w: 1200,
		h: 520,
		kind: "daemon",
		title: "HOW THE DAEMON RUNS, PER PLATFORM",
	});
	const plat = [
		[
			"p_mac",
			"macOS: launchd service",
			["~/Library/LaunchAgents/com.8gent.daemon.plist", "`8gent daemon install`"],
			"packages/daemon/service.ts:1-12",
			"daemon",
		],
		[
			"p_lin",
			"Linux: systemd --user + linger",
			["~/.config/systemd/user/com.8gent.daemon.service", "CI: platforms.yml runs service.e2e"],
			"packages/daemon/service.ts:1-12; .github/workflows/platforms.yml:78-98",
			"daemon",
		],
		[
			"p_win",
			"Windows: Scheduled Task",
			["com.8gent.daemon at logon, no admin", "CI: windows-task.yml, windows-smoke.yml"],
			"packages/daemon/service.ts:1-12; .github/workflows/windows-task.yml",
			"daemon",
		],
		[
			"p_hz",
			"Hetzner: system units + compose",
			[
				"infra/hetzner/systemd/eight-daemon.service runs bun run packages/daemon/index.ts",
				"plus two eight-bridge-*.service",
			],
			"infra/hetzner/systemd/eight-daemon.service",
			"daemon",
		],
		[
			"p_fly",
			"Fly.io eight-vessel",
			["fly.toml runs the board vessel, not the daemon; daemon on Fly UNVERIFIED"],
			"fly.toml; scripts/board-vessel/entrypoint.sh",
			"unv",
		],
		[
			"p_and",
			"Android / Termux: UNVERIFIED (#4852)",
			["service.ts rejects other platforms: foreground `8gent daemon run` only"],
			"packages/daemon/service.ts:450-455",
			"unv",
		],
	];
	const gPlat = sc.grid(1500, platY + 70, 3, 360, 20, 20, plat, (a, x, _y, w) =>
		S(a[0], { x, y: 0, w, title: a[1], body: a[2], src: a[3], kind: a[4], tfs: 16, bfs: 12 }),
	);

	fPlat.h = gPlat.y + gPlat.h - fPlat.y + 30;
	// Gap callouts column
	const fG = sc.frame({
		x: 2780,
		y: 0,
		w: 640,
		h: 1640,
		kind: "gap",
		title: "GAPS ON THIS MAP",
		sub: "Evidence for each is in view 4 and the README gap table.",
	});
	let gy = 100;
	for (const id of [
		"G01",
		"G02",
		"G03",
		"G04",
		"G05",
		"G06",
		"G07",
		"G08",
		"G09",
		"G10",
		"G13",
		"G14",
		"G15",
		"G16",
		"G18",
		"G19",
	]) {
		const b = gapBox(sc, id, 2800, gy, 600);
		gy += b.h + 18;
	}
	fG.h = gy;

	// Packages
	const topBottom = Math.max(fE.h, fApps.h, fPlat.y + fPlat.h, fG.h) + 60;
	let px = 0;
	let py = topBottom + 100;
	let col = 0;
	let rowMax = 0;
	const seen = new Set();
	PKG_GROUPS.forEach(([title, pk], gi) => {
		const cols = 4;
		const cellW = 250;
		const rows = Math.ceil(pk.length / cols);
		const fw = cols * cellW + (cols - 1) * 14 + 32;
		const fh = 62 + rows * 82;
		sc.frame({ x: px, y: py, w: fw, h: fh, kind: "pkg", title: `packages/*  ${title}` });
		sc.grid(px + 16, py + 56, cols, cellW, 14, 14, pk, (p, x, _y, w) => {
			seen.add(p[0]);
			return S(`pk_${p[0]}`, {
				x,
				y: 0,
				w,
				h: 68,
				title: `packages/${p[0]}`,
				body: [p[1]],
				src: `packages/${p[0]}`,
				kind: p[2] === "gap" ? "gap" : "pkg",
				tfs: 14,
				bfs: 11,
			});
		});
		rowMax = Math.max(rowMax, fh);
		col++;
		px += fw + 40;
		if (col === 3) {
			col = 0;
			px = 0;
			py += rowMax + 40;
			rowMax = 0;
		}
	});
	const all = readdirSync(join(repo, "packages"), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	const missing = all.filter((n) => !seen.has(n));
	const extra = [...seen].filter((n) => !all.includes(n));
	if (missing.length || extra.length)
		throw new Error(`package register drift: missing ${missing} extra ${extra}`);

	// tag the boxes each gap is about
	const T = (box, ...ids) => ids.forEach((g) => sc.tag(box, g));
	T("p_and", "G01");
	T("e_termux", "G01");
	T("p_fly", "G02");
	T("p_mac", "G03");
	T("e_bin", "G04");
	T("a_comp", "G05");
	T("a_lil", "G05");
	T("pk_tools", "G07");
	T("pk_eight", "G08");
	T("pk_auth", "G09");
	T("pk_quarantine", "G09");
	T("pk_registry", "G09");
	T("pk_hands", "G09");
	T("pk_lsp", "G09");
	T("pk_tasks", "G09");
	T("pk_personality", "G09");
	T("pk_design-agent", "G09");
	T("pk_planning", "G09");
	T("pk_executor", "G09");
	T("pk_i18n", "G09");
	T("pk_repo-context", "G09");
	T("d_cron", "G13");
	T("pk_cron", "G13");
	T("pk_g8way", "G16");
	T("d_tg", "G19");
	T("pk_telegram", "G19");
	T("pk_telegram-bot", "G19");
	T("a_bot", "G19");
	T("pk_planner", "G06");
	T("pk_dreams", "G06");
	T("pk_qdrant-client", "G06");
	T("pk_channels", "G06");
	T("pk_control-plane", "G06");
	T("pk_8dk", "G06");
	T("pk_threat-feed", "G10");
	T("a_cvx", "G14");
	T("a_clui", "G15");
	T("a_dbg", "G18");

	// flow arrows
	const A = (f, t, l, src, o = {}) => sc.arrow(f, t, l, { src, ...o });
	A("e_npm", "e_run", "bin entry", "package.json");
	A("e_run", "e_cli", "spawns dist/cli.js (bundle of bin/8gent.ts)", "bin/8gent-run.js");
	A("e_bin", "e_cli", "bun --compile of bin/8gent.ts", "scripts/build-binaries.ts");
	A("e_inst", "e_bin", "downloads the release binary", "scripts/install.sh");
	A("e_gha", "e_bin", "builds, signs, attests", ".github/workflows/release-binaries.yml");
	A("e_termux", "e_run", "npm .tgz, node runtime", "scripts/install.sh");
	A("e_cli", "a_tui", "`8gent tui`", "bin/8gent.ts");
	A("e_cli", "d_svc", "`8gent daemon run|install|status`", "bin/8gent.ts:573-578");
	A("a_tui", "d_gw", "ws :18789, sessions and auto-attach", "apps/tui/src/lib/daemon-sessions.ts");
	A("a_comp", "d_gw", "ws /computer", "apps/8gent-computer/README.md");
	A("d_gw", "d_pool", "session turns", "packages/daemon/agent-pool.ts");
	A("d_pool", "pk_eight", "runs the 8gent loop", "packages/daemon/agent-pool.ts");
	A("a_tui", "pk_eight", "in-process loop when no daemon", "apps/tui/src/app.tsx:25");
	A(
		"pk_eight",
		"pk_providers",
		"chat() through ProviderManager",
		"packages/eight/clients/index.ts",
	);
	A("d_svc", "p_mac", "writes plist, launchctl bootstrap", "packages/daemon/service.ts");
	A("d_svc", "p_lin", "writes user unit, enables linger", "packages/daemon/service.ts");
	A("d_svc", "p_win", "registers Scheduled Task", "packages/daemon/service.ts");
	A("p_hz", "d_gw", "same daemon, system unit", "infra/hetzner/systemd/eight-daemon.service");

	sc.legend(-20, py + rowMax + 80, [
		["entry", "Entry point or distribution"],
		["app", "App"],
		["daemon", "Daemon"],
		["pkg", "Package"],
		["unv", "UNVERIFIED"],
		["gap", "Gap (evidence in README)"],
	]);
	return sc;
}

// ------------------------------------------------------------ view 2
function externalMap() {
	const sc = new Scene(
		"02-external-tools-and-services",
		"8gent-code: external tools and services",
		"What 8gent talks to. Every arrow says what flows. Grey dashed = off until the user opts in; solid = on by default or auto-enabled on a qualifying host. [Gnn] tags point at the red gap cards in view 4.",
	);
	const S = (id, o) => sc.box(id, o);

	// ---- left: providers (compact)
	const prov = (prefix, list, x, y, cols, cellW, kind) =>
		sc.grid(x, y, cols, cellW, 14, 14, list, (p, gx, _gy, w) =>
			S(`${prefix}_${p[0]}`, {
				x: gx,
				y: 0,
				w,
				title: p[0],
				body: [p[1]],
				src: p[2],
				kind: p[3] ?? kind,
				tfs: 16,
				bfs: 12,
			}),
		);
	let fy = 0;
	const fLocal = sc.frame({
		x: 0,
		y: fy,
		w: 1240,
		h: 300,
		kind: "app",
		title: "LOCAL PROVIDERS: ON BY DEFAULT",
		sub: "enabled: true in the compiled table (llama-server is the exception)",
	});
	const g1 = prov(
		"pv",
		[
			[
				"8gent",
				"http://localhost:11434, default model eight-1.0-q3:14b",
				"packages/providers/index.ts:274-288",
			],
			["ollama", "http://localhost:11434, no key", "packages/providers/index.ts:289-304"],
			[
				"lmstudio",
				"LMSTUDIO_BASE_URL or http://localhost:1234/v1",
				"packages/providers/index.ts:305-324",
			],
			[
				"llama-server",
				"OFF unless EIGHT_LOCAL_SERVER=llama-server (turns Ollama off)",
				"packages/providers/index.ts:325-339",
				"optin",
			],
		],
		20,
		fy + 80,
		2,
		580,
		"app",
	);
	fLocal.h = g1.y + g1.h - fLocal.y + 24;
	fy = fLocal.y + fLocal.h + 30;
	const fAuto = sc.frame({
		x: 0,
		y: fy,
		w: 1240,
		h: 200,
		kind: "ext",
		title: "AUTO-ENABLED ON A QUALIFYING HOST",
		sub: "macOS 26 + Apple Silicon + bridge binary present",
	});
	const g2 = prov(
		"pa",
		[
			[
				"apple-foundation",
				"IPC to ~/.8gent/bin/apple-foundation-bridge, no URL",
				"packages/providers/index.ts:340-354",
			],
			[
				"apfel",
				"APFEL_BASE_URL or http://127.0.0.1:11435/v1",
				"packages/providers/index.ts:355-377",
			],
		],
		20,
		fy + 80,
		2,
		580,
		"ext",
	);
	fAuto.h = g2.y + g2.h - fAuto.y + 24;
	fy = fAuto.y + fAuto.h + 30;
	const fCloud = sc.frame({
		x: 0,
		y: fy,
		w: 1240,
		h: 500,
		kind: "optin",
		title: "CLOUD PROVIDERS: OPT-IN WITH AN API KEY (enabled: false)",
		sub: "key from ~/.8gent/keys.env or the secrets vault; nothing leaves until a key exists",
	});
	const g3 = prov(
		"pc",
		[
			[
				"openrouter",
				"https://openrouter.ai/api/v1; failover target for :free models",
				"packages/providers/index.ts:391-411",
			],
			["deepseek", "https://api.deepseek.com/v1", "packages/providers/index.ts:378-390"],
			["groq", "https://api.groq.com/openai/v1", "packages/providers/index.ts:412-429"],
			["grok", "https://api.x.ai/v1", "packages/providers/index.ts:430-442"],
			["openai", "https://api.openai.com/v1", "packages/providers/index.ts:443-457"],
			["anthropic", "https://api.anthropic.com/v1", "packages/providers/index.ts:458-472"],
			["mistral", "https://api.mistral.ai/v1", "packages/providers/index.ts:473-490"],
			[
				"minimax",
				"MINIMAX_BASE_URL or https://api.minimax.io/v1",
				"packages/providers/index.ts:491-506",
			],
			["together", "https://api.together.xyz/v1", "packages/providers/index.ts:507-523"],
			["fireworks", "https://api.fireworks.ai/inference/v1", "packages/providers/index.ts:524-539"],
			["replicate", "https://api.replicate.com/v1", "packages/providers/index.ts:540-552"],
		],
		20,
		fy + 80,
		3,
		380,
		"optin",
	);
	fCloud.h = g3.y + g3.h - fCloud.y + 24;
	fy = fCloud.y + fCloud.h + 30;
	const fHost = sc.frame({
		x: 0,
		y: fy,
		w: 1240,
		h: 200,
		kind: "optin",
		title: "HOST CLI SUBPROCESS: OPT-IN",
		sub: "PROVIDERS_ALLOW_HOST_CLI=1 plus a bound binary on PATH; text only",
	});
	const g4 = prov(
		"ph",
		[
			[
				"host-cli-primary",
				"reuses the host binary's own session, no URL",
				"packages/providers/index.ts:553-567",
			],
			["host-cli-secondary", "same, second binding", "packages/providers/index.ts:568-582"],
		],
		20,
		fy + 80,
		2,
		580,
		"optin",
	);
	fHost.h = g4.y + g4.h - fHost.y + 24;
	fy = fHost.y + fHost.h + 50;

	// ---- judges (left, under providers)
	const fJ = sc.frame({ x: 0, y: fy, w: 1240, h: 900, kind: "daemon", title: "JUDGES" });
	const jd = [
		[
			"j_sel",
			"Selene-1-Mini (Atla) via Ollama: the shipped local judge",
			[
				"on by default through System One; /api/generate verdicts, /api/pull install on one yes",
				"fails closed: unreachable means FAIL",
			],
			"packages/providers/local-judge.ts:1-30",
			"daemon",
		],
		[
			"j_ol",
			"Ollama (localhost:11434)",
			["/api/tags, /api/pull, /api/generate; also serves the 8gent and ollama providers"],
			"packages/local-model-server/index.ts",
			"daemon",
		],
		[
			"j_llama",
			"llama.cpp in-process (node-llama-cpp, optional dependency)",
			["first backend createDecider() tries"],
			"packages/decide/README.md:31-36",
			"daemon",
		],
		[
			"j_laya",
			"laya backend",
			["second in the auto order, then Ollama"],
			"packages/decide/backends/laya.ts",
			"daemon",
		],
		[
			"j_8j",
			"8J on a Hugging Face Space (8GI/8j-eval, ZeroGPU)",
			[
				"opt-in: G8WAY_UPSTREAMS + EIGHT_ALLOW_HOSTED=1 + read-only HF token",
				"reply allow, ask or block plus p_yes; bands unproven on a held-out set",
			],
			"packages/g8way/README.md:50-75",
			"optin",
		],
		[
			"j_g8",
			"g8way proxy (api.8gentos.com, Hetzner)",
			["OpenAI-compatible, Clerk JWT, OpenRouter routing; deploy unit not in repo"],
			"packages/g8way/README.md:1-12",
			"unv",
		],
		[
			"j_8gate",
			"'8gate' local judge name",
			["appears only in provider-choice.test.ts and model-routed-event.test.ts"],
			"packages/eight/provider-choice.test.ts",
			"gap",
		],
		[
			"j_sky",
			"Skywork-Reward-V2 over a vLLM-style endpoint",
			["scalar reward ranking, optional"],
			"packages/providers/local-judge.ts:7-10",
			"optin",
		],
	];
	const gj = sc.grid(20, fy + 60, 2, 580, 20, 16, jd, (a, x, _y, w) =>
		S(a[0], { x, y: 0, w, title: a[1], body: a[2], src: a[3], kind: a[4], tfs: 15, bfs: 12 }),
	);
	fJ.h = gj.y + gj.h - fJ.y + 24;

	// ---- centre column
	const CX = 1500;
	const fC = sc.frame({
		x: CX - 20,
		y: 0,
		w: 640,
		h: 2300,
		kind: "daemon",
		title: "8GENT RUNTIME",
	});
	const c = (id, title, body, src, y, kind = "daemon") =>
		S(id, { x: CX, y, w: 600, title, body, src, kind, tfs: 17, bfs: 13 });
	let cy = 80;
	const next = (id, title, body, src, kind) => {
		const b = c(id, title, body, src, cy, kind);
		cy += b.h + 40;
	};
	next(
		"c_daemon",
		"packages/daemon",
		["ws/http :18789, Telegram bridge, Slack, cron, Table"],
		"packages/daemon/index.ts",
	);
	next(
		"c_eng",
		"packages/eight (the 8gent loop)",
		["tools, prompts, session store, honesty and done gates"],
		"packages/eight/agent.ts",
	);
	next(
		"c_pm",
		"ProviderManager",
		["packages/providers/index.ts: 20 entries, failover, PII egress gate, locality ledger"],
		"packages/providers/index.ts:274-577",
	);
	next(
		"c_perm",
		"System One gate + permissions",
		["rules first, then a calibrated judge; deny by default"],
		"packages/permissions/system-one-gate.ts",
	);
	next(
		"c_decide",
		"packages/decide (judge host)",
		["backends: llamacpp in-process, laya, ollama; Selene calibration files"],
		"packages/decide/README.md",
	);
	next(
		"c_voice",
		"packages/voice + tools/speak.ts",
		["STT in, TTS out"],
		"packages/voice/index.ts",
	);
	next("c_music", "packages/music (DJ)", ["streams YouTube audio"], "packages/music/dj.ts");
	next(
		"c_deck",
		"packages/deck, film-craft, table/bake",
		["decks and films to mp4"],
		"packages/deck/auto.ts",
	);
	next(
		"c_tf",
		"packages/threat-feed (manual CLI)",
		["bun packages/threat-feed/cli.ts [--file-issues]"],
		"packages/threat-feed/cli.ts",
		"gap",
	);
	next(
		"c_bp",
		"board-plane + board-vessel (Fly)",
		["control plane with Discord gateway; officer vessels connect by wss"],
		"packages/board-plane/control-plane.ts",
	);
	next(
		"c_li",
		"apps/linkedin-vessel (Fly)",
		["outreach vessel with MCP server"],
		"apps/linkedin-vessel/src/index.ts",
	);
	next(
		"c_qd",
		"packages/qdrant-client",
		["every method throws NotImplementedError"],
		"packages/qdrant-client/README.md",
		"gap",
	);
	next(
		"c_cp",
		"packages/control-plane",
		["tenant, billing, Stripe webhook; no caller"],
		"packages/control-plane/index.ts",
		"gap",
	);
	fC.h = cy;

	// ---- right: services (one column, ordered by the centre box that talks to them)
	const SX = 2380;
	const fS = sc.frame({
		x: SX - 20,
		y: 0,
		w: 700,
		h: 1800,
		kind: "ext",
		title: "SERVICES AND NETWORK HOSTS",
	});
	const svc = [
		[
			"s_tg",
			"Telegram Bot API",
			["api.telegram.org: inbound messages and voice, outbound text, files, voice notes"],
			"packages/daemon/telegram-bridge.ts",
			"ext",
		],
		["s_slack", "Slack", ["slack.com chat.postMessage"], "packages/daemon/slack.ts:138", "ext"],
		[
			"s_gh",
			"GitHub (api.github.com and gh)",
			["issues, PRs, releases, repo and lockfile reads; self-update asset downloads"],
			"packages/toolshed/tools/github/github-tools.ts",
			"ext",
		],
		[
			"s_npm",
			"npm registry",
			["registry.npmjs.org: self-update version check; release.yml publishes with OIDC"],
			"packages/eight/self-update.ts:182",
			"ext",
		],
		[
			"s_vercel",
			"Vercel API",
			["api.vercel.com: projects, deployments, env, domains, deployment logs"],
			"packages/eight/tools.ts:2027",
			"ext",
		],
		[
			"s_web",
			"DuckDuckGo or SearXNG",
			["web_search tool; html.duckduckgo.com unless a search endpoint is set"],
			"packages/tools/web.ts:4",
			"ext",
		],
		[
			"s_letsfg",
			"LetsFG API",
			["api.letsfg.co flight search"],
			"packages/travel/letsfg-provider.ts:81",
			"ext",
		],
		[
			"s_clerk",
			"Clerk",
			["JWT verification (g8way via @8gent/auth), sign-in"],
			"packages/auth/clerk.ts",
			"ext",
		],
		[
			"s_convex",
			"Convex",
			["CONVEX_URL: accounts, session tracking, preference sync; offline when unset"],
			"packages/db/client.ts:63",
			"ext",
		],
		[
			"s_osv",
			"OSV and CISA KEV",
			["api.osv.dev querybatch and vulns, cisa.gov known_exploited_vulnerabilities.json"],
			"packages/threat-feed/feeds.ts:6-9",
			"ext",
		],
		[
			"s_oai",
			"OpenAI cloud transcription",
			["Whisper API fallback when local whisper.cpp is missing"],
			"packages/voice/cloud-transcriber.ts",
			"optin",
		],
		[
			"s_el",
			"ElevenLabs",
			["listed as 'future, placeholder' in the TTS engine"],
			"packages/voice/tts-engine.ts:7",
			"unv",
		],
		[
			"s_disc",
			"Discord REST",
			["discord.com/api/v10 from the board plane"],
			"packages/board-plane/discord-rest.ts:8",
			"ext",
		],
		[
			"s_relay",
			"Board plane and model proxy (Fly)",
			["wss://8gi-board-plane.fly.dev, http://8gi-model-proxy.internal:3200"],
			"fly.toml",
			"ext",
		],
		[
			"s_li",
			"LinkedIn API",
			["campaign outreach from apps/linkedin-vessel"],
			"apps/linkedin-vessel/src/linkedin-api.ts",
			"ext",
		],
		[
			"s_qd",
			"Qdrant",
			["local vector store seam, stubs throw"],
			"packages/qdrant-client/README.md",
			"gap",
		],
		[
			"s_stripe",
			"Stripe",
			["webhook and billing code with no caller"],
			"packages/control-plane/stripe-webhook.ts",
			"gap",
		],
		[
			"s_hf",
			"Hugging Face",
			["hf.co GGUF pull of the Selene judge through Ollama; private Space 8GI/8j-eval for 8J"],
			"packages/eight/judge-install.ts",
			"ext",
		],
	];
	const gs = sc.grid(SX, 70, 1, 660, 20, 14, svc, (a, x, _y, w) =>
		S(a[0], { x, y: 0, w, title: a[1], body: a[2], src: a[3], kind: a[4], tfs: 16, bfs: 12 }),
	);
	fS.h = gs.y + gs.h - fS.y + 24;

	// ---- far right: local tools
	const TX = 3200;
	const fT = sc.frame({
		x: TX - 20,
		y: 0,
		w: 700,
		h: 1800,
		kind: "out",
		title: "LOCAL TOOLS AND BINARIES",
	});
	const tl = [
		[
			"t_wh",
			"whisper.cpp + sox",
			["local STT, mic recording, models in ~/.8gent/models/whisper"],
			"packages/voice/index.ts:1-4",
		],
		[
			"t_tts",
			"say, KittenTTS (Python), Termux TTS, moshi-mlx",
			["spoken replies"],
			"packages/voice/tts-engine.ts:31",
		],
		[
			"t_mpv",
			"mpv + yt-dlp",
			["DJ search and playback, mpv IPC socket"],
			"packages/music/dj.ts:5-8",
		],
		[
			"t_ff",
			"ffmpeg",
			["deck and film rendering, Table bake, key detection"],
			"packages/tools/video-deck.ts",
		],
		[
			"t_mg",
			"ImageMagick (magick)",
			["film-craft title cards and grade; permission rule s1-magick"],
			"packages/film-craft/index.ts:4",
		],
		["t_rg", "ripgrep", ["locate tool text and file search"], "packages/ast-index/locate.ts:26"],
		[
			"t_cl",
			"cliclick, osascript, screencapture",
			["desktop driver for the computer-use path"],
			"packages/hands/index.ts",
		],
		["t_ch", "Chrome", ["render backend for HTML to image and video"], "packages/render/chrome.ts"],
		[
			"t_bu",
			"browser-use CLI (Python)",
			["wrapped in packages/tools/browser-use.ts"],
			"packages/tools/browser-use.ts:1-10",
		],
		[
			"t_af",
			"apple-foundation-bridge + 8gent-ax-bridge",
			[
				"Swift helpers in ~/.8gent/bin, installed by scripts/install-apple-foundation.ts and packages/eyes/native/build.sh",
			],
			"scripts/install-apple-foundation.ts",
		],
	];
	const gt = sc.grid(TX, 70, 1, 660, 20, 14, tl, (a, x, _y, w) =>
		S(a[0], { x, y: 0, w, title: a[1], body: a[2], src: a[3], kind: "out", tfs: 15, bfs: 12 }),
	);
	fT.h = gt.y + gt.h - fT.y + 24;

	// ---- arrows
	const A = (f, t, l, src, o = {}) => sc.arrow(f, t, l, { src, ...o });
	A(
		"c_pm",
		"pv_ollama",
		"chat, tool calls, stream; no key (same for 8gent, lmstudio, llama-server)",
		"packages/providers/index.ts:289-304",
	);
	A(
		"c_pm",
		"pa_apple-foundation",
		"prompt over IPC to the bridge binary",
		"packages/providers/index.ts:340-354",
	);
	A(
		"c_pm",
		"pa_apfel",
		"OpenAI-style chat on 127.0.0.1:11435",
		"packages/providers/index.ts:355-377",
	);
	A(
		"c_pm",
		"pc_openrouter",
		"failover: local -> OpenRouter :free",
		"packages/providers/failover.ts",
	);
	A(
		"c_pm",
		"pc_anthropic",
		"chat with key, after the PII egress gate",
		"packages/providers/index.ts:458-472",
	);
	A(
		"c_pm",
		"pc_openai",
		"chat with key (same shape for the other cloud entries)",
		"packages/providers/index.ts:443-457",
	);
	A(
		"c_pm",
		"ph_host-cli-primary",
		"spawns the host binary, text only",
		"packages/providers/host-cli.ts",
	);
	A(
		"pa_apple-foundation",
		"t_af",
		"IPC socket to the Swift bridge",
		"scripts/install-apple-foundation.ts",
	);
	A("c_eng", "c_pm", "every model call", "packages/eight/clients/index.ts");
	A(
		"c_perm",
		"c_decide",
		"bashGuard(command) asks, gets p(yes)",
		"packages/permissions/system-one-gate.ts",
	);
	A(
		"c_decide",
		"j_sel",
		"yes/no question + state, calibrated p(yes)",
		"packages/decide/judge-model.ts",
	);
	A("c_decide", "j_llama", "in-process, no server", "packages/decide/backends/llamacpp.ts");
	A("c_decide", "j_laya", "fallback backend", "packages/decide/backends/laya.ts");
	A("j_sel", "j_ol", "/api/generate verdict, /api/pull install", "packages/eight/judge-install.ts");
	A("j_ol", "s_hf", "pulls hf.co GGUF (Selene)", "packages/eight/judge-install.ts");
	A("j_g8", "j_8j", "model prefix 8j/ routed upstream", "packages/g8way/README.md:50-75");
	A("j_g8", "pc_openrouter", "non-8j models to OpenRouter", "packages/g8way/README.md:1-12");
	A("j_8j", "s_hf", "HTTPS to the Space, read-only HF token", "packages/g8way/README.md:63-70");
	A(
		"c_daemon",
		"s_tg",
		"updates in; text, voice, files out",
		"packages/daemon/telegram-bridge.ts",
		{ both: true },
	);
	A("c_daemon", "s_slack", "chat.postMessage", "packages/daemon/slack.ts:138");
	A(
		"c_eng",
		"s_gh",
		"issues, PRs, repo reads via gh and REST",
		"packages/toolshed/tools/github/github-tools.ts",
	);
	A(
		"c_eng",
		"s_npm",
		"version check, tarball for self-update",
		"packages/eight/self-update.ts:182",
	);
	A("c_eng", "s_vercel", "vercel_* tools: deploy, env, logs", "packages/eight/tools.ts:2027");
	A("c_eng", "s_web", "web_search query, results", "packages/tools/web.ts:4");
	A("c_eng", "s_letsfg", "flight search request", "packages/travel/letsfg-provider.ts:81");
	A("c_eng", "s_clerk", "sign-in tokens", "packages/auth/clerk.ts");
	A("c_eng", "s_convex", "preference, usage, session sync", "packages/db/client.ts:63");
	A("c_tf", "s_osv", "querybatch, advisory records, KEV json", "packages/threat-feed/feeds.ts:6-9");
	A("c_tf", "s_gh", "lockfile reads; one issue per repo", "packages/threat-feed/issues.ts");
	A("c_bp", "s_disc", "Discord messages", "packages/board-plane/discord-rest.ts:8");
	A("c_bp", "s_relay", "wss control plane, model proxy", "fly.toml");
	A("c_li", "s_li", "campaign calls", "apps/linkedin-vessel/src/linkedin-api.ts");
	A("c_cp", "s_stripe", "webhook events (no caller)", "packages/control-plane/stripe-webhook.ts");
	A("c_qd", "s_qd", "stub only", "packages/qdrant-client/README.md");
	A("c_voice", "t_wh", "mic audio to whisper.cpp", "packages/voice/index.ts:1-4");
	A(
		"c_voice",
		"s_oai",
		"audio to transcript, cloud fallback",
		"packages/voice/cloud-transcriber.ts",
	);
	A("c_voice", "t_tts", "text to spoken audio", "packages/voice/tts-engine.ts:31");
	A("c_voice", "s_el", "placeholder, not implemented", "packages/voice/tts-engine.ts:7");
	A("c_music", "t_mpv", "stream URL, IPC volume", "packages/music/dj.ts:5-8");
	A("c_deck", "t_ff", "frames and audio to mp4", "packages/tools/video-deck.ts");
	A("c_deck", "t_mg", "title cards and grade", "packages/film-craft/index.ts:4");
	A("c_eng", "t_rg", "locate query", "packages/ast-index/locate.ts:26");
	A("c_eng", "t_cl", "click, type, screenshot", "packages/hands/index.ts");
	A("c_eng", "t_ch", "layout_compare renders HTML", "packages/tools/layout-compare.ts");
	A("c_eng", "t_bu", "browser_* tool calls", "packages/eight/tools.ts");
	sc.tag("c_tf", "G10");
	sc.tag("s_convex", "G14");
	sc.tag("j_8gate", "G17");
	sc.tag("j_g8", "G16");
	sc.tag("c_qd", "G06");
	sc.tag("c_cp", "G06");
	sc.tag("s_stripe", "G06");
	sc.tag("s_qd", "G06");

	// gaps strip + legend under everything
	const gyBase = Math.max(fC.h, fS.h, fT.h, fJ.y + fJ.h) + 60;
	const fG = sc.frame({ x: 0, y: gyBase, w: 2040, h: 300, kind: "gap", title: "GAPS ON THIS MAP" });
	let gx = 20;
	for (const id of ["G06", "G10", "G14", "G16", "G17"]) {
		gapBox(sc, id, gx, gyBase + 70, 390);
		gx += 405;
	}
	fG.h =
		70 +
		Math.max(...["G06", "G10", "G14", "G16", "G17"].map((id) => sc.boxes.get(`gap_${id}`).h)) +
		30;
	sc.legend(2380, gyBase, [
		["daemon", "8gent runtime"],
		["app", "Local provider, on by default"],
		["ext", "External service or auto-enabled"],
		["optin", "Opt-in, off by default"],
		["out", "Local tool or binary"],
		["unv", "UNVERIFIED"],
		["gap", "Gap (evidence in README)"],
	]);
	return sc;
}

export default async function main(build) {
	const parts = {};
	parts.s1 = build("01-system-map", systemMap());
	parts.s2 = build("02-external-tools-and-services", externalMap());
	const { outputsMap, gapsMap } = await import("./scenes2.mjs");
	parts.s3 = build("03-outputs", outputsMap({ Scene, GAPS, gapBox, gap }));
	parts.s4 = build("04-gaps", gapsMap({ Scene, GAPS }));
	const { readme } = await import("./readme.mjs");
	writeFileSync(join(here, "..", "README.md"), readme(parts, GAPS, PKG_GROUPS));
	const TSV = build.TSV;
	writeFileSync(
		join(here, "..", "sources.tsv"),
		["type\tview\tname\tkind\tsource path", ...TSV].join("\n") + "\n",
	);
	console.log("built");
}
