/**
 * Runs the daemon as a per-user background service that starts at login.
 *
 *   darwin  launchd agent   ~/Library/LaunchAgents/com.8gent.daemon.plist
 *   linux   systemd --user  ~/.config/systemd/user/com.8gent.daemon.service, plus linger
 *   win32   Scheduled Task  "com.8gent.daemon", at logon, no admin rights
 *
 * Every operation is a plan of steps built from a ServiceContext, so the exact
 * files and commands for each platform are data that tests assert without
 * touching the machine. Plans converge: install twice leaves one running
 * service, uninstall on a clean machine succeeds.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHome } from "../core/home";

export const SERVICE_LABEL = "com.8gent.daemon";
const DESCRIPTION = "Eight Agent Daemon - always-on AI agent process";

export type ServicePlatform = "darwin" | "linux" | "win32";
export type ServiceOperation = "install" | "uninstall" | "start" | "stop";

export interface ServiceContext {
	platform: ServicePlatform;
	home: string;
	/** Absolute argv that runs the daemon in the foreground, e.g. [bun, cli.js, "daemon", "run"]. */
	program: string[];
	/** launchd domain target (darwin only). */
	uid: number;
	/** Login name for linger (linux), DOMAIN\user for the task principal (win32). */
	user: string;
}

export type Step =
	| { kind: "mkdir"; path: string }
	| { kind: "write"; path: string; contents: string }
	| { kind: "remove"; path: string }
	| {
			kind: "run";
			argv: string[];
			onFailure: "abort" | "ignore" | { warn: string };
			attempts?: number;
	  }
	| { kind: "powershell"; script: string };

type QueryStep = Extract<Step, { kind: "run" | "powershell" }>;

export type ServiceState =
	| { state: "not-installed" }
	| { state: "stopped" }
	| { state: "running"; pid?: number }
	| { state: "unavailable"; reason: string };

export interface CommandResult {
	code: number;
	stdout: string;
}

interface Backend {
	/** Where the service definition lives on disk, or null when the OS stores it. */
	definitionPath(ctx: ServiceContext): string | null;
	/** Must succeed before install, start, stop or status mean anything on this host. */
	probe?: { argv: string[]; unavailable: string };
	plans: Record<ServiceOperation, (ctx: ServiceContext) => Step[]>;
	statusQuery(ctx: ServiceContext): QueryStep;
	parseStatus(result: CommandResult, definitionExists: boolean): ServiceState;
}

const run = (argv: string[], attempts?: number): Step =>
	attempts
		? { kind: "run", argv, onFailure: "abort", attempts }
		: { kind: "run", argv, onFailure: "abort" };
const tolerate = (argv: string[]): Step => ({ kind: "run", argv, onFailure: "ignore" });

function paths(ctx: ServiceContext) {
	const p = ctx.platform === "win32" ? path.win32 : path.posix;
	const logDir = p.join(ctx.home, ".8gent");
	return {
		logDir,
		log: p.join(logDir, "daemon.log"),
		errLog: p.join(logDir, "daemon-error.log"),
		plist: p.join(ctx.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
		unit: p.join(ctx.home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`),
	};
}

// ----- darwin -----

const xmlEscape = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(ctx: ServiceContext): string {
	const { log, errLog } = paths(ctx);
	const args = ctx.program.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ctx.home)}</string>
</dict>
</plist>
`;
}

const launchdTarget = (ctx: ServiceContext) => `gui/${ctx.uid}/${SERVICE_LABEL}`;

const launchd: Backend = {
	definitionPath: (ctx) => paths(ctx).plist,
	plans: {
		install: (ctx) => [
			{ kind: "mkdir", path: path.posix.dirname(paths(ctx).plist) },
			{ kind: "mkdir", path: paths(ctx).logDir },
			{ kind: "write", path: paths(ctx).plist, contents: launchdPlist(ctx) },
			tolerate(["launchctl", "bootout", launchdTarget(ctx)]),
			tolerate(["launchctl", "enable", launchdTarget(ctx)]),
			// bootout returns before launchd finishes tearing the job down, so an
			// immediate bootstrap can fail with EIO. Retrying rides that out.
			run(["launchctl", "bootstrap", `gui/${ctx.uid}`, paths(ctx).plist], 5),
		],
		uninstall: (ctx) => [
			tolerate(["launchctl", "bootout", launchdTarget(ctx)]),
			{ kind: "remove", path: paths(ctx).plist },
		],
		start: (ctx) => [
			tolerate(["launchctl", "bootstrap", `gui/${ctx.uid}`, paths(ctx).plist]),
			run(["launchctl", "kickstart", launchdTarget(ctx)]),
		],
		// KeepAlive relaunches a killed job, so stopping means unloading it.
		stop: (ctx) => [tolerate(["launchctl", "bootout", launchdTarget(ctx)])],
	},
	statusQuery: (ctx) => ({
		kind: "run",
		argv: ["launchctl", "print", launchdTarget(ctx)],
		onFailure: "ignore",
	}),
	parseStatus: ({ code, stdout }, defined) => {
		if (code === 0 && /^\s*state = running$/m.test(stdout)) {
			const pid = stdout.match(/^\s*pid = (\d+)$/m);
			return pid ? { state: "running", pid: Number(pid[1]) } : { state: "running" };
		}
		return defined ? { state: "stopped" } : { state: "not-installed" };
	},
};

// ----- linux -----

const systemdQuote = (arg: string) =>
	/[\s"'\\]/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg;

export function systemdUnit(ctx: ServiceContext): string {
	const { log, errLog } = paths(ctx);
	return `[Unit]
Description=${DESCRIPTION}
After=network.target

[Service]
Type=simple
ExecStart=${ctx.program.map(systemdQuote).join(" ")}
Restart=always
RestartSec=5
WorkingDirectory=${ctx.home}
StandardOutput=append:${log}
StandardError=append:${errLog}

[Install]
WantedBy=default.target
`;
}

const UNIT = `${SERVICE_LABEL}.service`;

const systemd: Backend = {
	definitionPath: (ctx) => paths(ctx).unit,
	probe: {
		argv: ["systemctl", "--user", "show-environment"],
		unavailable:
			"systemd user services are not available on this machine (common in WSL1 and containers). Run the daemon in the foreground instead: 8gent daemon run",
	},
	plans: {
		install: (ctx) => [
			{ kind: "mkdir", path: path.posix.dirname(paths(ctx).unit) },
			{ kind: "mkdir", path: paths(ctx).logDir },
			{ kind: "write", path: paths(ctx).unit, contents: systemdUnit(ctx) },
			run(["systemctl", "--user", "daemon-reload"]),
			run(["systemctl", "--user", "enable", UNIT]),
			run(["systemctl", "--user", "restart", UNIT]),
			// Without linger the user manager, and the daemon with it, exits at logout.
			{
				kind: "run",
				argv: ["loginctl", "enable-linger", ctx.user],
				onFailure: {
					warn: `Could not enable linger, so the daemon stops when you log out. To keep it running: sudo loginctl enable-linger ${ctx.user}`,
				},
			},
		],
		uninstall: (ctx) => [
			tolerate(["systemctl", "--user", "disable", "--now", UNIT]),
			{ kind: "remove", path: paths(ctx).unit },
			tolerate(["systemctl", "--user", "daemon-reload"]),
		],
		start: () => [run(["systemctl", "--user", "start", UNIT])],
		stop: () => [run(["systemctl", "--user", "stop", UNIT])],
	},
	statusQuery: () => ({
		kind: "run",
		argv: ["systemctl", "--user", "is-active", UNIT],
		onFailure: "ignore",
	}),
	parseStatus: ({ stdout }, defined) => {
		if (stdout.trim() === "active") return { state: "running" };
		return defined ? { state: "stopped" } : { state: "not-installed" };
	},
};

// ----- win32 -----

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const TASK = psQuote(SERVICE_LABEL);

/**
 * The task runs a hidden PowerShell host that invokes the daemon: a console
 * program started directly by an interactive task opens a window at every
 * logon, and the host is also what appends the daemon's output to the log.
 */
export function scheduledTaskScript(ctx: ServiceContext): string {
	const invoke = `& ${ctx.program.map(psQuote).join(" ")} 2>&1 | Out-File -FilePath ${psQuote(paths(ctx).log)} -Append -Encoding utf8`;
	const argument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${invoke}"`;
	return `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(argument)} -WorkingDirectory ${psQuote(ctx.home)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${psQuote(ctx.user)}
$principal = New-ScheduledTaskPrincipal -UserId ${psQuote(ctx.user)} -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName ${TASK} -Description ${psQuote(DESCRIPTION)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`;
}

/**
 * Ending a task stops only the host process it launched, so the daemon the
 * host spawned is matched by its executable and trailing arguments and
 * stopped as well. Only the tail is matched because PowerShell re-quotes the
 * middle arguments when a path contains spaces.
 */
export function stopTaskScript(ctx: ServiceContext): string {
	const exe = ctx.program[0] ?? "";
	const tail = ctx.program.slice(-2).join(" ");
	return `Stop-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(exe)} -and $_.CommandLine -like ${psQuote(`* ${tail}`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
}

const scheduledTask: Backend = {
	definitionPath: () => null,
	plans: {
		install: (ctx) => [
			{ kind: "mkdir", path: paths(ctx).logDir },
			{ kind: "powershell", script: stopTaskScript(ctx) },
			{ kind: "powershell", script: scheduledTaskScript(ctx) },
			{ kind: "powershell", script: `Start-ScheduledTask -TaskName ${TASK}\n` },
		],
		uninstall: (ctx) => [
			{ kind: "powershell", script: stopTaskScript(ctx) },
			{
				kind: "powershell",
				script: `Unregister-ScheduledTask -TaskName ${TASK} -Confirm:$false -ErrorAction SilentlyContinue\n`,
			},
		],
		start: () => [{ kind: "powershell", script: `Start-ScheduledTask -TaskName ${TASK}\n` }],
		stop: (ctx) => [{ kind: "powershell", script: stopTaskScript(ctx) }],
	},
	statusQuery: () => ({
		kind: "powershell",
		script: `$t = Get-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue
if ($t) { $t.State } else { 'NotInstalled' }
`,
	}),
	parseStatus: ({ stdout }) => {
		const state = stdout.trim();
		if (state === "Running") return { state: "running" };
		if (state === "NotInstalled" || state === "") return { state: "not-installed" };
		return { state: "stopped" };
	},
};

const BACKENDS: Record<ServicePlatform, Backend> = {
	darwin: launchd,
	linux: systemd,
	win32: scheduledTask,
};

export function planFor(op: ServiceOperation, ctx: ServiceContext): Step[] {
	return BACKENDS[ctx.platform].plans[op](ctx);
}

export function parseStatus(
	platform: ServicePlatform,
	result: CommandResult,
	definitionExists: boolean,
): ServiceState {
	return BACKENDS[platform].parseStatus(result, definitionExists);
}

export function powershellArgv(script: string): string[] {
	// -EncodedCommand sidesteps Windows command-line quoting for multi-line scripts.
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return [
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		encoded,
	];
}

// ----- execution -----

async function exec(argv: string[]): Promise<CommandResult & { stderr: string }> {
	try {
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} catch (err) {
		// Bun.spawn throws when the executable is missing, e.g. no systemctl.
		return { code: 127, stdout: "", stderr: String(err) };
	}
}

export class ServiceError extends Error {}

async function execute(step: Step, log: (line: string) => void): Promise<void> {
	switch (step.kind) {
		case "mkdir":
			mkdirSync(step.path, { recursive: true });
			return;
		case "write":
			writeFileSync(step.path, step.contents);
			return;
		case "remove":
			rmSync(step.path, { force: true });
			return;
		case "powershell": {
			const res = await exec(powershellArgv(step.script));
			if (res.code !== 0)
				throw new ServiceError(`PowerShell failed (${res.code}): ${res.stderr.trim()}`);
			return;
		}
		case "run": {
			let res = await exec(step.argv);
			for (let i = 1; res.code !== 0 && i < (step.attempts ?? 1); i++) {
				await Bun.sleep(500);
				res = await exec(step.argv);
			}
			if (res.code === 0 || step.onFailure === "ignore") return;
			if (step.onFailure === "abort") {
				throw new ServiceError(`${step.argv.join(" ")} failed (${res.code}): ${res.stderr.trim()}`);
			}
			log(`[service] warning: ${step.onFailure.warn}`);
			return;
		}
	}
}

async function unavailableReason(ctx: ServiceContext): Promise<string | null> {
	const probe = BACKENDS[ctx.platform].probe;
	if (!probe) return null;
	return (await exec(probe.argv)).code === 0 ? null : probe.unavailable;
}

export async function serviceStatus(ctx: ServiceContext): Promise<ServiceState> {
	const reason = await unavailableReason(ctx);
	if (reason) return { state: "unavailable", reason };
	const backend = BACKENDS[ctx.platform];
	const query = backend.statusQuery(ctx);
	const res = await exec(query.kind === "powershell" ? powershellArgv(query.script) : query.argv);
	const definition = backend.definitionPath(ctx);
	return backend.parseStatus(res, definition !== null && existsSync(definition));
}

export async function runOperation(
	op: ServiceOperation,
	ctx: ServiceContext,
	log: (line: string) => void = console.log,
): Promise<void> {
	if (op !== "uninstall") {
		const reason = await unavailableReason(ctx);
		if (reason) throw new ServiceError(reason);
	}
	if (op === "start" || op === "stop") {
		const { state } = await serviceStatus(ctx);
		if (state === "not-installed") {
			throw new ServiceError("The daemon service is not installed. Run: 8gent daemon install");
		}
	}
	for (const step of planFor(op, ctx)) await execute(step, log);
}

export function describeState(s: ServiceState): string {
	switch (s.state) {
		case "running":
			return s.pid ? `running (pid ${s.pid})` : "running";
		case "stopped":
			return "installed, not running";
		case "not-installed":
			return "not installed";
		case "unavailable":
			return `unavailable. ${s.reason}`;
	}
}

export function hostContext(program: string[]): ServiceContext {
	const platform = process.platform;
	if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
		throw new ServiceError(
			`A background service is not supported on ${platform}. Run: 8gent daemon run`,
		);
	}
	return {
		platform,
		home: resolveHome(process.env, platform),
		program,
		uid: process.getuid?.() ?? 0,
		user:
			platform === "win32"
				? `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`
				: os.userInfo().username,
	};
}

const SUBCOMMANDS = ["install", "uninstall", "start", "stop", "status"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];
const isSubcommand = (s: string | undefined): s is Subcommand =>
	SUBCOMMANDS.includes(s as Subcommand);

/**
 * `8gent daemon <sub>`. `program` is the argv that runs `8gent daemon run` on
 * this install. Resolves to an exit code, or null while the daemon runs in the
 * foreground.
 */
export async function daemonCommand(args: string[], program: string[]): Promise<number | null> {
	const sub = args[0];
	if (sub === "run") {
		const { main } = await import("./index");
		await main();
		return null;
	}
	if (!isSubcommand(sub)) {
		console.log("Usage: 8gent daemon <run|install|uninstall|start|stop|status>");
		return sub ? 1 : 0;
	}
	try {
		const ctx = hostContext(program);
		if (sub !== "status") {
			await runOperation(sub, ctx);
			console.log(`[service] ${sub} done`);
		}
		console.log(`[service] ${SERVICE_LABEL}: ${describeState(await serviceStatus(ctx))}`);
		return 0;
	} catch (err) {
		if (!(err instanceof ServiceError)) throw err;
		console.error(`[service] ${err.message}`);
		return 1;
	}
}
