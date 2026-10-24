// View 3 (outputs) and view 4 (gaps).

export function outputsMap({ Scene, gapBox }) {
	const sc = new Scene(
		"03-outputs",
		"8gent-code: every place it writes",
		"Paths are taken from the code that writes them (the source path is the writer). 'read by' names the code that reads the output back; a red box is written but has no reader or no writer in the repo.",
	);
	const S = (id, o) => sc.box(id, o);

	S("hub", {
		x: 1750,
		y: 0,
		w: 1000,
		h: 190,
		kind: "daemon",
		title: "8gent runtime",
		body: [
			"TUI (apps/tui), daemon (packages/daemon), CLI (bin/8gent.ts), CI (.github/workflows)",
			"~/.8gent is $EIGHT_DATA_DIR when set (packages/daemon/data-dir.ts:20), otherwise the home directory",
		],
		src: "packages/daemon/data-dir.ts:20",
		tfs: 20,
		bfs: 14,
	});

	// ---- zone A: ~/.8gent
	const fA = sc.frame({
		x: 0,
		y: 330,
		w: 1520,
		h: 2520,
		kind: "out",
		title: "~/.8gent  (local data directory)",
	});
	const o = (path, what, src, kind = "out") => [path, what, src, kind];
	const A = [
		o(
			"sessions/<id>.jsonl",
			"session transcript, one JSON entry per line. Written by SessionWriter; read by TUI resume and the daemon's shared sessions (session-store.ts:50)",
			"packages/specifications/session/writer.ts:37",
		),
		o(
			"sessions/durable/<key>.jsonl",
			"durable turn ledger, fsynced append per record; read on kill-resume and by durable-verify",
			"packages/specifications/session/durable-ledger.ts:65",
		),
		o(
			"sessions/<id>/ (packed tool outputs)",
			"ObservationStore; read back when a turn needs a truncated tool result",
			"packages/eight/agent.ts:4857",
		),
		o(
			"turns/<session>/<n>.json",
			"per-turn replay record. read by: scripts/turn-review-replay.ts only (G11)",
			"packages/eight/turn-journal.ts:59",
			"gap",
		),
		o(
			"timetravel/blobs + sessions/<id>/checkpoints.jsonl",
			"content-addressed checkpoints for rewind and fork",
			"packages/eight/timetravel/checkpoint-store.ts:229",
		),
		o(
			"daemon.log, tui.log, debug.log",
			"process logs; collected by `8gent bug`",
			"packages/eight/bug-report.ts:130",
		),
		o("logs/tools.log", "tool call log, protected from 8gent writes", "packages/core/shell.ts:176"),
		o(
			"memory/memory.db",
			"global memory: SQLite, FTS5, vectors, graph; project memory goes to <repo>/.8gent/memory or the state dir",
			"packages/memory/index.ts:321-328",
		),
		o("memory/shared-memory.db", "memory bus shared across sessions", "packages/memory/bus.ts:359"),
		o(
			"memory/memory.db.enc, telegram-sessions*.json",
			"encrypted Telegram memory vault (key in the macOS keychain) and bridge session map",
			"packages/memory/telegram-memory-vault.ts:99",
		),
		o(
			"table/table.db",
			"Table channels, members, messages; every mutation also hits the signed goal ledger",
			"packages/table/store.ts:60",
		),
		o(
			"cron.json",
			"scheduled jobs. Two writers: packages/cron and packages/daemon/cron.ts (G13)",
			"packages/daemon/cron.ts:35",
			"gap",
		),
		o(
			"runs.jsonl",
			"one record per run, including failed turns; read by readRuns in the REPL",
			"packages/reporting/runlog.ts:92",
		),
		o(
			"permissions-audit.jsonl",
			"every permission decision",
			"packages/permissions/user-policy.ts:51",
		),
		o(
			"approvals-audit.jsonl",
			"channel approval decisions, mode 0600",
			"packages/daemon/channel-approvals.ts:111",
		),
		o(
			"settings.json",
			"typed settings: voice, performance, models, providers, ui",
			"packages/settings/index.ts:4",
		),
		o(
			"providers.json, user.json",
			"declared providers (read by agent.ts:431) and preferences (self-autonomy/preferences-sync.ts:38)",
			"packages/eight/agent.ts:431",
		),
		o(
			"keys.env and secrets/",
			"API keys written by `8gent keys set`; AES-256-GCM vault tied to the machine",
			"packages/self-autonomy/onboarding.ts:627",
		),
		o("mcp.json", "MCP servers 8gent connects to", "packages/mcp/config.ts:57"),
		o("hooks.yaml, hooks.json", "user lifecycle hooks", "packages/hooks/index.ts:145"),
		o(
			"extensions/, skills/, prompts/",
			"user code and prompts loaded at start; guarded as startup-code dirs",
			"packages/permissions/path-guard.ts:90",
		),
		o("tasks.json", "persistent task tracker", "packages/tasks/index.ts:5"),
		o("usage.json", "per-provider usage monitor", "packages/providers/usage-monitor.ts:33"),
		o("router.json", "task router config", "packages/ai/task-router.ts:65"),
		o(
			"locality.jsonl",
			"one JSON line per model call: local or cloud",
			"packages/providers/locality.ts:98",
		),
		o("update-check.json", "update notice state", "packages/eight/update-notice.ts:111"),
		o(
			"bug-reports/",
			"local report folder from `8gent bug`; uploads nothing",
			"packages/eight/bug-report.ts:97",
		),
		o("browser-shots/", "browser tool screenshots", "packages/eight/tools.ts:5263"),
		o("creative/", "music beds and generated media", "packages/music/dj.ts:168"),
		o(
			"daemon-state.json, sessions-journal.json",
			"journal for EIGHT_RESUME_ON_BOOT",
			"packages/daemon/session-journal.ts",
		),
		o("post-message.log", "log of posted messages", "packages/ai/post-message.ts:221"),
		o("mesh/", "agent mesh state", "packages/orchestration/agent-mesh.ts:112"),
		o("models/whisper/", "downloaded whisper.cpp models", "packages/voice/model-manager.ts:5"),
		o(
			"kernel/training/ (off by default)",
			"RL fine-tune training pairs",
			"packages/kernel/personal-collector.ts:49",
		),
		o(
			"security/threat-feed/<date>/",
			"report.json and summary.md. read by: nobody (G10)",
			"packages/threat-feed/README.md",
			"gap",
		),
		o(
			"evidence/",
			"no writer in the repo (G12); only a design-doc comment names it",
			"apps/tui/src/components/IntroBanner.tsx:2",
			"gap",
		),
	];
	const gA2 = sc.grid(20, 410, 3, 480, 14, 14, A, (a, x, _y, w) =>
		S(`h_${a[0]}`, {
			x,
			y: 0,
			w,
			title: a[0],
			body: [a[1]],
			src: a[2],
			kind: a[3],
			tfs: 15,
			bfs: 12,
		}),
	);

	fA.h = gA2.y + gA2.h - fA.y + 30;

	// ---- zone B: user's repo
	const fB = sc.frame({
		x: 1620,
		y: 330,
		w: 1120,
		h: 700,
		kind: "app",
		title: "IN THE USER'S REPO",
	});
	const B = [
		o(
			"source files",
			"write_file and edit_file tool calls, hashline edits; permission and path guards first",
			"packages/eight/tools.ts",
			"app",
		),
		o(
			"git commits",
			"git_add and git_commit tools; commit-gate refuses a commit while tests fail",
			"packages/eight/commit-gate.ts:8",
			"app",
		),
		o(
			".gitignore line",
			"`.8gent/` appended once so state stays out of git",
			"packages/memory/project-state.ts:91",
			"app",
		),
		o(
			".8gent/worktrees/",
			"git worktrees for parallel sub-8gents",
			"packages/orchestration/worktree-manager.ts:32",
			"app",
		),
		o(
			".8gent/state.db",
			"workspace state shared by harness and processes",
			"packages/db/src/workspace-db.ts:4",
			"app",
		),
		o(
			"decks, PDFs, game scaffolds",
			"Marp deck .md (auto-rendered to video), make_pdf output, gamedev scaffold",
			"packages/deck/auto.ts",
			"app",
		),
	];
	const gB = sc.grid(1640, 410, 2, 540, 14, 14, B, (a, x, _y, w) =>
		S(`r_${a[0]}`, {
			x,
			y: 0,
			w,
			title: a[0],
			body: [a[1]],
			src: a[2],
			kind: a[3],
			tfs: 15,
			bfs: 12,
		}),
	);

	fB.h = gB.y + gB.h - fB.y + 24;

	// ---- zone C: sent elsewhere
	const fC = sc.frame({
		x: 2780,
		y: 330,
		w: 1120,
		h: 790,
		kind: "ext",
		title: "SENT TO OTHER SYSTEMS",
	});
	const C = [
		o(
			"Telegram messages",
			"text, voice notes, files from the bridge and notify actuator",
			"packages/daemon/telegram-bridge.ts",
			"ext",
		),
		o(
			"Slack and Discord posts",
			"chat.postMessage; Discord REST from the board plane",
			"packages/daemon/slack.ts:138",
			"ext",
		),
		o(
			"GitHub issues and PRs",
			"github-tools and gh-issue-file; threat-feed drafts one issue per repo",
			"packages/toolshed/tools/github/github-tools.ts",
			"ext",
		),
		o("Vercel deployments", "vercel_deploy, vercel_set_env", "packages/eight/tools.ts:2027", "ext"),
		o(
			"Convex sync",
			"preferences, usage, session tracking when CONVEX_URL is set",
			"packages/db/client.ts:63",
			"ext",
		),
		o(
			"Hosted judge calls",
			"shell commands sent to 8J only if G8WAY_UPSTREAMS and EIGHT_ALLOW_HOSTED=1",
			"packages/g8way/README.md:63-70",
			"optin",
		),
	];
	const gC = sc.grid(2800, 410, 2, 540, 14, 14, C, (a, x, _y, w) =>
		S(`x_${a[0]}`, {
			x,
			y: 0,
			w,
			title: a[0],
			body: [a[1]],
			src: a[2],
			kind: a[3],
			tfs: 15,
			bfs: 12,
		}),
	);

	fC.h = gC.y + gC.h - fC.y + 24;

	// ---- zone D: releases
	const dY = fB.y + fB.h + 40;
	const fD = sc.frame({
		x: 1620,
		y: dY,
		w: 1120,
		h: 580,
		kind: "entry",
		title: "RELEASES AND PACKAGES",
	});
	const D = [
		o(
			"npm package",
			"published by release.yml with trusted publishing and provenance",
			".github/workflows/release.yml:29-37",
			"entry",
		),
		o(
			"GitHub Release + binaries",
			"6 binaries, SHA256SUMS signed with minisign, build attestation",
			".github/workflows/release-binaries.yml",
			"entry",
		),
		o(
			"deb, rpm, Windows installer",
			"nfpm.yaml, installer.nsi built by scripts/package-linux.sh and package-windows.ps1",
			"packaging/linux/nfpm.yaml",
			"entry",
		),
		o(
			"winget manifests",
			"8GIFoundation.8gentCode yaml triple",
			"packaging/winget/8GIFoundation.8gentCode.yaml",
			"entry",
		),
	];
	const gD = sc.grid(1640, dY + 80, 2, 540, 14, 14, D, (a, x, _y, w) =>
		S(`rel_${a[0]}`, {
			x,
			y: 0,
			w,
			title: a[0],
			body: [a[1]],
			src: a[2],
			kind: a[3],
			tfs: 15,
			bfs: 12,
		}),
	);

	fD.h = gD.y + gD.h - fD.y + 24;

	// ---- zone E: audio and video
	const eY = fC.y + fC.h + 40;
	const fE = sc.frame({
		x: 2780,
		y: eY,
		w: 1120,
		h: 300,
		kind: "daemon",
		title: "AUDIO AND VIDEO",
	});
	const E = [
		o(
			"spoken audio",
			"say, KittenTTS, Termux TTS from the speak tool",
			"packages/tools/speak.ts",
			"daemon",
		),
		o(
			"mp4 decks and films",
			"render_video_deck, film-craft, Table bake via ffmpeg and magick",
			"packages/tools/video-deck.ts",
			"daemon",
		),
		o("music playback", "mpv fed by yt-dlp search", "packages/music/dj.ts", "daemon"),
	];
	const gE = sc.grid(2800, eY + 80, 3, 350, 14, 14, E, (a, x, _y, w) =>
		S(`av_${a[0]}`, {
			x,
			y: 0,
			w,
			title: a[0],
			body: [a[1]],
			src: a[2],
			kind: a[3],
			tfs: 15,
			bfs: 12,
		}),
	);

	fE.h = gE.y + gE.h - fE.y + 24;

	// gap callouts
	const gyB = fA.y + fA.h + 40;
	const fGp = sc.frame({ x: 0, y: gyB, w: 1520, h: 300, kind: "gap", title: "GAPS ON THIS MAP" });
	let gx = 20;
	for (const id of ["G10", "G11", "G12", "G13"]) {
		gapBox(sc, id, gx, gyB + 70, 360);
		gx += 375;
	}

	const L = (f, t, l, src, o2 = {}) => sc.arrow(f, t, l, { src, ...o2 });
	L(
		"hub",
		"h_sessions/<id>.jsonl",
		"appends and fsyncs; atomic writes for state files",
		"packages/specifications/session/writer.ts:37",
	);
	L("hub", "r_source files", "tool calls after permission checks", "packages/eight/tools.ts");
	L(
		"hub",
		"x_Telegram messages",
		"replies and notifications",
		"packages/daemon/telegram-bridge.ts",
	);
	L(
		"hub",
		"rel_npm package",
		"tag push runs the release workflow",
		".github/workflows/release.yml:29-37",
	);
	L("hub", "av_spoken audio", "speak tool", "packages/tools/speak.ts");
	sc.tag("h_turns/<session>/<n>.json", "G11");
	sc.tag("h_evidence/", "G12");
	sc.tag("h_security/threat-feed/<date>/", "G10");
	sc.tag("h_cron.json", "G13");

	fGp.h =
		70 + Math.max(...["G10", "G11", "G12", "G13"].map((id) => sc.boxes.get(`gap_${id}`).h)) + 30;
	sc.legend(1620, Math.max(fD.y + fD.h, fE.y + fE.h) + 40, [
		["out", "Local file or directory"],
		["app", "Written into the user's repo"],
		["ext", "Sent to another system"],
		["optin", "Opt-in"],
		["entry", "Release artifact"],
		["daemon", "Audio or video"],
		["gap", "Gap (evidence in README)"],
	]);
	return sc;
}

export function gapsMap({ Scene, GAPS }) {
	const sc = new Scene(
		"04-gaps",
		"8gent-code: gaps",
		"What the code on origin/main shows is missing, unwired or unverified. Each card names its file evidence. Nothing here is inferred from memory; every claim has a path.",
	);
	const cats = [
		["platform", "PLATFORMS AND DEPLOYMENT"],
		["dead", "DEAD CODE"],
		["untested", "NO TESTS"],
		["unread", "OUTPUTS NOBODY READS"],
		["moving-parts", "DUPLICATE MOVING PARTS"],
		["unverified", "UNVERIFIED OR OUTSIDE THE REPO"],
		["docs", "DOCS DRIFT"],
	];
	let x = 0;
	for (const [cat, title] of cats) {
		const items = GAPS.filter((g) => g.cat === cat);
		if (!items.length) continue;
		sc.frame({ x, y: 0, w: 640, h: 2300, kind: "gap", title });
		let y = 70;
		for (const g of items) {
			const b = sc.box(`g_${g.id}`, {
				x: x + 20,
				y,
				w: 600,
				kind: g.cat === "unverified" ? "unv" : "gap",
				title: `${g.id}  ${g.t}`,
				body: [g.d, `Evidence: ${g.ev.join(" ; ")}`],
				src: g.ev[0],
				tfs: 17,
				bfs: 13,
			});
			y += b.h + 20;
		}
		x += 680;
	}
	const maxB = Math.max(...[...sc.boxes.values()].map((b) => b.y + b.h));
	for (const f of sc.frames) f.h = maxB + 60;
	return sc;
}
