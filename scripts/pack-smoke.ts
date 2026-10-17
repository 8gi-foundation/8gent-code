#!/usr/bin/env bun
/**
 * Pack-and-install smoke for the npm package (#3219).
 *
 * "Merged" is not "shipped": 0.17.0 went to npm with the build machine's
 * absolute paths baked into dist/cli.js and a TUI bundle that could not load,
 * and nothing noticed because on the builder's Mac the baked paths resolve.
 * This runs what a newcomer runs, against the exact tarball npm would publish:
 *
 *   1. bun run build                     (skip with --skip-build)
 *   2. npm pack                          -> tarball must contain dist/cli.js, dist/tui.js
 *   3. scan the packed bundles           -> no build root, no builder home, no "/Users/<name>/,
 *                                           no hardcoded owner identity (any commit author's
 *                                           full name or email, the builder's git name/email
 *                                           and profile name, or PACK_SMOKE_OWNER_IDENTITY)
 *   4. npm install -g --prefix <tmp>     with an isolated HOME and a minimal PATH
 *   5. 8gent --version                   must print this package.json version
 *   6. 8gent tui --no-pet under a pty    must render its first screen (greeting or status bar)
 *   5b. literal asset reads in the bundles (new URL(rel, import.meta.url), join(__dirname, rel))
 *                                        must all exist in the installed package
 *   5c. 8gent chat / 8gent run           against a local stub model (scripts/lib/packed-install-probes.ts):
 *                                           chat answers, run completes and its deck_theme tool
 *                                           call returns themes, so a lazily read file that is not
 *                                           packaged fails here
 *   (step 3 also fails any bundle that reads a .sql file from disk: SQL must be inlined)
 *
 * Exits non-zero if any check fails. Nothing is published.
 * Dependency install scripts are skipped (--ignore-scripts) so the smoke does
 * not compile native modules; the user's npm cache is reused to save a download.
 * That is why it missed #3256 (node-pty failing to build on a bare Linux box).
 * --bare-linux adds the stranger's install too: the same tarball, install
 * scripts ON, in a clean node:22-bookworm-slim container with no Python or
 * compiler (scripts/bare-install-smoke.sh; needs Docker). The Linux CI job
 * runs that script on every pull request.
 *
 * Disk: an install is about 1 GB. The smoke uses ONE fixed folder,
 * $TMPDIR/8gent-pack-smoke, wipes it at the start, and removes it at the end
 * whether the checks pass, fail, throw, or are interrupted. It then fails if
 * any 8gent-pack-smoke* folder is left in $TMPDIR. --keep leaves the folder
 * for debugging (and skips the leftover check); the next run wipes it.
 *
 *   bun scripts/pack-smoke.ts [--skip-build] [--keep] [--tui-seconds N] [--bare-linux]
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	collectOwnerIdentities,
	envIdentities,
	findOwnerIdentity,
	maskIdentity,
} from "./lib/owner-identity-scan";
import { missingAssetReads, startStubModel } from "./lib/packed-install-probes";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const TUI_SECONDS = Number(args[args.indexOf("--tui-seconds") + 1]) || 60;
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;
const TMP_PREFIX = "8gent-pack-smoke";
const TMP = join(realpathSync(tmpdir()), TMP_PREFIX);

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ""): boolean {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
	if (!ok) failures.push(label);
	return ok;
}
function run(cmd: string, argv: string[], opts: Parameters<typeof spawnSync>[2] = {}) {
	const r = spawnSync(cmd, argv, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...opts });
	return {
		status: r.status ?? 1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		stdout: `${r.stdout ?? ""}`,
	};
}

// Bundled dependency reads whose file is not installed. Reachability is UNVERIFIED:
// source-map's wasm is only read by SourceMapConsumer, which no shipped command
// constructs as far as the checks here show. Each entry needs a reason; none is a
// first-party file.
const UNREACHED_DEP_ASSETS = ["node_modules/source-map/lib/mappings.wasm"];

let tuiChild: ChildProcess | null = null;
function stopTui(): void {
	if (tuiChild?.pid && tuiChild.exitCode === null) {
		try {
			process.kill(-tuiChild.pid, "SIGTERM"); // our own detached process group only
		} catch {}
	}
}
function cleanup(): void {
	stopTui();
	if (KEEP) {
		console.log(`kept: ${TMP}`);
		return;
	}
	rmSync(TMP, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(sig, () => {
		cleanup();
		process.exit(130);
	});
}

// Terminal escape sequences (CSI and OSC), built from ESC so the source holds
// no raw control characters.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");
const stripAnsi = (raw: string) => raw.replace(CSI_RE, "").replace(OSC_RE, "");

async function main(): Promise<void> {
	const HOME = join(TMP, "home");
	const WORK = join(TMP, "work");
	const PREFIX = join(TMP, "prefix");
	const EXTRACT = join(TMP, "extract");
	rmSync(TMP, { recursive: true, force: true }); // reuse one folder, never accumulate
	for (const d of [HOME, WORK, EXTRACT]) mkdirSync(d, { recursive: true });

	// 1. Build
	if (!args.includes("--skip-build")) {
		const b = run("bun", ["run", "build"], { cwd: ROOT });
		if (!check(b.status === 0, "build", b.status === 0 ? "" : b.out.slice(-800))) return;
	}

	// 2. Pack
	const pack = run("npm", ["pack", "--json", "--pack-destination", TMP], { cwd: ROOT });
	let tarball = "";
	let packed: string[] = [];
	try {
		const info = JSON.parse(pack.stdout)[0];
		tarball = join(TMP, info.filename);
		packed = info.files.map((f: { path: string }) => f.path);
	} catch {}
	if (
		!check(existsSync(tarball), "npm pack produced a tarball", tarball ? "" : pack.out.slice(-800))
	)
		return;
	for (const f of ["bin/8gent-run.js", "dist/cli.js", "dist/tui.js", "dist/pty-bridge.cjs"]) {
		check(packed.includes(f), `tarball contains ${f}`);
	}

	// 2b. Optional: install the same tarball on a bare Linux machine (#3256).
	if (args.includes("--bare-linux")) {
		const bare = spawnSync("sh", [join(ROOT, "scripts", "bare-install-smoke.sh"), tarball], {
			stdio: "inherit",
		});
		check(bare.status === 0, "bare-machine Linux install (scripts/bare-install-smoke.sh)");
	}

	// 3. Scan the packed bundles for build-machine paths
	run("tar", ["-xzf", tarball, "-C", EXTRACT]);
	const buildRoots = new Set([ROOT]);
	try {
		buildRoots.add(dirname(realpathSync(join(ROOT, "node_modules"))));
	} catch {}
	const home = homedir();
	// The owner identity is read from the running user at runtime; no real
	// person's name or email may be baked into a bundle (v0.18.0 shipped one).
	// Keep each secret entry out of the Actions log, whatever prints it.
	if (process.env.GITHUB_ACTIONS === "true") {
		for (const v of envIdentities(process.env.PACK_SMOKE_OWNER_IDENTITY)) {
			console.log(`::add-mask::${v}`);
		}
	}
	const ownerIdentities = collectOwnerIdentities({ root: ROOT, home });
	check(ownerIdentities.length > 0, "owner-identity scan has identities to look for");
	// The release job sets this so the gate never rests on who happens to build.
	if (process.env.PACK_SMOKE_REQUIRE_OWNER_IDENTITY === "1") {
		check(
			envIdentities(process.env.PACK_SMOKE_OWNER_IDENTITY).length > 0,
			"PACK_SMOKE_OWNER_IDENTITY is set (repository secret)",
		);
	}
	for (const f of ["dist/cli.js", "dist/tui.js"]) {
		const p = join(EXTRACT, "package", f);
		if (!existsSync(p)) continue;
		const src = readFileSync(p, "utf-8");
		const usersLiterals = src.match(/["'`]\/Users\/[^"'`/\s]+\//g) ?? [];
		check(
			usersLiterals.length === 0,
			`${f} has no "/Users/<name>/ literals`,
			`${usersLiterals.length} found`,
		);
		for (const r of buildRoots) check(!src.includes(r), `${f} has no build root ${r}`);
		if (home.length > 1) check(!src.includes(`"${home}/`), `${f} has no builder home ${home}`);
		// SQL beside the bundle is not in the package (#4355): it must be a text import.
		const sqlReads = src.match(/(?:new URL|path\w*\.join|join)\([^)\n]*\.sql["'`]/g) ?? [];
		check(sqlReads.length === 0, `${f} reads no .sql file from disk`, sqlReads.join(" | "));
		const baked = findOwnerIdentity(src, ownerIdentities);
		check(
			baked.length === 0,
			`${f} has no hardcoded owner name or email`,
			baked.map(maskIdentity).join(", "),
		);
	}
	rmSync(EXTRACT, { recursive: true, force: true });

	// 4. Install into an isolated prefix with an isolated HOME
	const npmCache = run("npm", ["config", "get", "cache"]).stdout.trim();
	const bunBin = dirname(realpathSync(Bun.which("bun") ?? process.execPath));
	const nodeBin = dirname(realpathSync(Bun.which("node") ?? "/usr/bin/node"));
	const env: Record<string, string> = {
		HOME,
		USERPROFILE: HOME,
		PATH: [join(PREFIX, "bin"), bunBin, nodeBin, "/usr/bin", "/bin"].join(":"),
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		npm_config_cache: npmCache,
		npm_config_update_notifier: "false",
		// Keep the machine's proxy so the install can reach the registry.
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([k, v]) => v !== undefined && /^(https?|no|all)_proxy$/i.test(k),
			) as [string, string][],
		),
		// No CI variable on purpose: Ink detects CI and suppresses rendering, and
		// the point is to see the screen a newcomer sees.
	};
	const install = run(
		"npm",
		["install", "-g", "--prefix", PREFIX, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
		{ cwd: WORK, env },
	);
	const bin = join(PREFIX, "bin", "8gent");
	const installed = install.status === 0 && existsSync(bin);
	if (
		!check(installed, "npm install -g from the tarball", installed ? "" : install.out.slice(-800))
	)
		return;

	// 5. 8gent --version
	const ver = run(bin, ["--version"], { cwd: WORK, env });
	check(
		ver.status === 0 && ver.out.includes(`v${VERSION}`),
		"8gent --version",
		ver.out.trim().split("\n").pop(),
	);

	// 5b. Every file the bundles read by a literal relative path must exist in the
	// INSTALLED package (#4355 follow-up). Reads through a variable are covered by 5c.
	const pkgRoot = join(PREFIX, "lib", "node_modules", "@8gi-foundation", "8gent-code");
	for (const f of ["cli.js", "tui.js"]) {
		const file = join(pkgRoot, "dist", f);
		const gone = (
			existsSync(file)
				? missingAssetReads(readFileSync(file, "utf-8"), join(pkgRoot, "dist"), existsSync)
				: []
		).filter((r) => !UNREACHED_DEP_ASSETS.some((a) => r.target.endsWith(a)));
		check(
			gone.length === 0,
			`dist/${f} asset reads all exist in the installed package`,
			gone.map((r) => r.target.replace(pkgRoot, "<pkg>")).join(", "),
		);
	}

	// 5c. chat and run against a stub model: the first prompt a newcomer types
	// (#4355). The stub gets `run` past "No Ollama models available" and has it call
	// deck_theme, a tool reached lazily whose index file was missing from the
	// package, so reads inside tools are exercised too. A failed tool call does not
	// crash `run`; the stub records the tool result and that is what is checked.
	const runCli = (argv: string[], stub: ReturnType<typeof startStubModel>) =>
		new Promise<{ status: number | null; out: string }>((done) => {
			const stubEnv = {
				...env,
				OLLAMA_BASE_URL: `http://127.0.0.1:${stub.port}`,
				EIGHT_DECIDE_OLLAMA_HOST: `http://127.0.0.1:${stub.port}`,
				NO_PROXY: "127.0.0.1,localhost",
				no_proxy: "127.0.0.1,localhost",
			};
			const c = spawn(bin, argv, { cwd: WORK, env: stubEnv, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			c.stdout?.on("data", (d) => {
				out += d;
			});
			c.stderr?.on("data", (d) => {
				out += d;
			});
			const t = setTimeout(() => c.kill("SIGKILL"), 60_000);
			c.on("exit", (status) => {
				clearTimeout(t);
				done({ status, out });
			});
		});
	const missingMarker = (out: string) =>
		["ENOENT", "Cannot find module", "Cannot find package"].find((m) => out.includes(m));
	const chatStub = startStubModel();
	const chat = await runCli(
		["chat", "--model", "stub:1b", "Say hello in one short sentence."],
		chatStub,
	);
	chatStub.stop();
	check(
		chat.status === 0 && chat.out.includes("hello from stub") && !missingMarker(chat.out),
		"8gent chat answers from the stub model",
		chat.out.slice(-300),
	);
	const runStub = startStubModel();
	const runRes = await runCli(["run", "List the deck themes."], runStub);
	const toolResult = runStub.toolResults[0] ?? "";
	runStub.stop();
	check(
		!missingMarker(runRes.out) && runRes.status === 0,
		"8gent run completes against the stub model",
		`exit ${runRes.status}: ${runRes.out.slice(-300)}`,
	);
	check(
		toolResult.includes('"themes"') && !missingMarker(toolResult) && !/failed/i.test(toolResult),
		"deck_theme list works from the installed package",
		toolResult.slice(0, 300) || "the stub never saw a tool result",
	);

	// 6. TUI launch under a pseudo-terminal: it must render its first screen.
	// The pty gets an explicit size: with no terminal on stdin it would be 0x0
	// and Ink would render nothing, which looks exactly like a hang.
	if (
		!check(
			run("sh", ["-c", "command -v script"]).status === 0,
			"`script` available to allocate a pty",
		)
	)
		return;
	const transcript = join(TMP, "tui.out");
	const launcher = join(TMP, "launch-tui.sh");
	writeFileSync(
		launcher,
		`stty cols 120 rows 40 2>/dev/null\nexec ${JSON.stringify(bin)} tui --no-pet\n`,
	);
	const scriptArgs =
		process.platform === "darwin"
			? ["-q", "-F", transcript, "sh", launcher]
			: ["-q", "-f", "-e", "-c", `sh ${JSON.stringify(launcher)}`, transcript];
	const child = spawn("script", scriptArgs, {
		cwd: WORK,
		env,
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
	});
	tuiChild = child;
	let exitCode: number | null = null;
	child.on("exit", (code) => {
		exitCode = code ?? 1;
	});
	// The first screen is the onboarding greeting or, once set up, the status bar.
	const FIRST_SCREEN = /I'm 8gent|8GENT FM/;
	const readText = () =>
		existsSync(transcript) ? stripAnsi(readFileSync(transcript, "utf-8")) : "";
	const deadline = Date.now() + TUI_SECONDS * 1000;
	let text = "";
	while (exitCode === null && Date.now() < deadline) {
		await Bun.sleep(500);
		text = readText();
		if (FIRST_SCREEN.test(text)) break;
	}
	const stillRunning = exitCode === null;
	stopTui();
	await Bun.sleep(500);
	text = readText();
	const crash = [
		"Cannot find package",
		"Cannot find module",
		"ENOENT",
		"TUI entry not found",
		"posix_spawn",
	].find((m) => text.includes(m));
	check(text.includes("Launching TUI"), "8gent tui reached the TUI launcher");
	check(!crash, "TUI start shows no load error", crash ? `saw "${crash}"` : "");
	check(FIRST_SCREEN.test(text), `TUI rendered its first screen within ${TUI_SECONDS}s`);
	check(
		stillRunning,
		"TUI was still running when the check ended",
		stillRunning ? "" : `exited with ${exitCode}`,
	);
	if (failures.length || process.env.PACK_SMOKE_SHOW_TUI) {
		console.log("\n--- TUI transcript (tail) ---");
		console.log(
			text
				.split("\n")
				.filter((l) => l.trim())
				.slice(-25)
				.join("\n"),
		);
	}
}

try {
	await main();
} catch (err) {
	check(false, "pack-smoke threw", String(err));
} finally {
	cleanup();
}
if (!KEEP) {
	const left = readdirSync(tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));
	check(left.length === 0, `no ${TMP_PREFIX}* folder left in ${tmpdir()}`, left.join(", "));
}
if (failures.length) {
	console.log(`\npack-smoke: ${failures.length} check(s) failed: ${failures.join("; ")}`);
	process.exit(1);
}
console.log(`\npack-smoke: all checks passed for @8gi-foundation/8gent-code@${VERSION}`);
process.exit(0);
