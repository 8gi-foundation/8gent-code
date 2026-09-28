import { describe, expect, test } from "bun:test";
import {
	type ServiceContext,
	daemonCommand,
	describeState,
	launchdPlist,
	parseStatus,
	planFor,
	powershellArgv,
	runOperation,
	scheduledTaskScript,
	serviceStatus,
	systemdUnit,
} from "./service";

const mac: ServiceContext = {
	platform: "darwin",
	home: "/Users/ada",
	program: ["/Users/ada/.bun/bin/bun", "/Users/ada/src/8gent/bin/8gent.ts", "daemon", "run"],
	uid: 501,
	user: "ada",
};

const linux: ServiceContext = {
	platform: "linux",
	home: "/home/ada",
	program: ["/home/ada/.bun/bin/bun", "/home/ada/My Code/bin/8gent.ts", "daemon", "run"],
	uid: 1000,
	user: "ada",
};

const windows: ServiceContext = {
	platform: "win32",
	home: "C:\\Users\\ada",
	program: [
		"C:\\Users\\ada\\.bun\\bin\\bun.exe",
		"C:\\Users\\ada\\ada's code\\bin\\8gent.ts",
		"daemon",
		"run",
	],
	uid: 0,
	user: "DESKTOP-1\\ada",
};

describe("macOS launchd agent", () => {
	test("plist runs the daemon program with logs under ~/.8gent", () => {
		expect(launchdPlist(mac)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.8gent.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/ada/.bun/bin/bun</string>
    <string>/Users/ada/src/8gent/bin/8gent.ts</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/Users/ada/.8gent/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/ada/.8gent/daemon-error.log</string>
  <key>WorkingDirectory</key>
  <string>/Users/ada</string>
</dict>
</plist>
`);
	});

	test("install writes the plist then reloads it with bootout and bootstrap", () => {
		const [mkAgents, mkLogs, write, ...commands] = planFor("install", mac);
		expect([mkAgents, mkLogs]).toEqual([
			{ kind: "mkdir", path: "/Users/ada/Library/LaunchAgents" },
			{ kind: "mkdir", path: "/Users/ada/.8gent" },
		]);
		expect(write).toEqual({
			kind: "write",
			path: "/Users/ada/Library/LaunchAgents/com.8gent.daemon.plist",
			contents: launchdPlist(mac),
		});
		expect(commands).toEqual([
			{
				kind: "run",
				argv: ["launchctl", "bootout", "gui/501/com.8gent.daemon"],
				onFailure: "ignore",
			},
			{
				kind: "run",
				argv: ["launchctl", "enable", "gui/501/com.8gent.daemon"],
				onFailure: "ignore",
			},
			{
				kind: "run",
				argv: [
					"launchctl",
					"bootstrap",
					"gui/501",
					"/Users/ada/Library/LaunchAgents/com.8gent.daemon.plist",
				],
				onFailure: "abort",
				attempts: 5,
			},
		]);
	});

	test("uninstall, start and stop never use the deprecated load and unload", () => {
		expect(planFor("uninstall", mac)).toEqual([
			{
				kind: "run",
				argv: ["launchctl", "bootout", "gui/501/com.8gent.daemon"],
				onFailure: "ignore",
			},
			{ kind: "remove", path: "/Users/ada/Library/LaunchAgents/com.8gent.daemon.plist" },
		]);
		expect(planFor("start", mac)).toEqual([
			{
				kind: "run",
				argv: [
					"launchctl",
					"bootstrap",
					"gui/501",
					"/Users/ada/Library/LaunchAgents/com.8gent.daemon.plist",
				],
				onFailure: "ignore",
			},
			{
				kind: "run",
				argv: ["launchctl", "kickstart", "gui/501/com.8gent.daemon"],
				onFailure: "abort",
			},
		]);
		expect(planFor("stop", mac)).toEqual([
			{
				kind: "run",
				argv: ["launchctl", "bootout", "gui/501/com.8gent.daemon"],
				onFailure: "ignore",
			},
		]);
	});

	test("status reads launchctl print", () => {
		const printed =
			"gui/501/com.8gent.daemon = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n}\n";
		expect(parseStatus("darwin", { code: 0, stdout: printed }, true)).toEqual({
			state: "running",
			pid: 4242,
		});
		expect(parseStatus("darwin", { code: 0, stdout: "\tstate = not running\n" }, true)).toEqual({
			state: "stopped",
		});
		expect(parseStatus("darwin", { code: 113, stdout: "" }, true)).toEqual({ state: "stopped" });
		expect(parseStatus("darwin", { code: 113, stdout: "" }, false)).toEqual({
			state: "not-installed",
		});
	});
});

describe("Linux systemd user unit", () => {
	test("unit quotes arguments that contain spaces", () => {
		expect(systemdUnit(linux)).toBe(`[Unit]
Description=Eight Agent Daemon - always-on AI agent process
After=network.target

[Service]
Type=simple
ExecStart=/home/ada/.bun/bin/bun "/home/ada/My Code/bin/8gent.ts" daemon run
Restart=always
RestartSec=5
WorkingDirectory=/home/ada
StandardOutput=append:/home/ada/.8gent/daemon.log
StandardError=append:/home/ada/.8gent/daemon-error.log

[Install]
WantedBy=default.target
`);
	});

	test("install enables, restarts and asks for linger with a fallback hint", () => {
		expect(planFor("install", linux)).toEqual([
			{ kind: "mkdir", path: "/home/ada/.config/systemd/user" },
			{ kind: "mkdir", path: "/home/ada/.8gent" },
			{
				kind: "write",
				path: "/home/ada/.config/systemd/user/com.8gent.daemon.service",
				contents: systemdUnit(linux),
			},
			{ kind: "run", argv: ["systemctl", "--user", "daemon-reload"], onFailure: "abort" },
			{
				kind: "run",
				argv: ["systemctl", "--user", "enable", "com.8gent.daemon.service"],
				onFailure: "abort",
			},
			{
				kind: "run",
				argv: ["systemctl", "--user", "restart", "com.8gent.daemon.service"],
				onFailure: "abort",
			},
			{
				kind: "run",
				argv: ["loginctl", "enable-linger", "ada"],
				onFailure: {
					warn: "Could not enable linger, so the daemon stops when you log out. To keep it running: sudo loginctl enable-linger ada",
				},
			},
		]);
	});

	test("uninstall tolerates a unit that was never loaded", () => {
		expect(planFor("uninstall", linux)).toEqual([
			{
				kind: "run",
				argv: ["systemctl", "--user", "disable", "--now", "com.8gent.daemon.service"],
				onFailure: "ignore",
			},
			{ kind: "remove", path: "/home/ada/.config/systemd/user/com.8gent.daemon.service" },
			{ kind: "run", argv: ["systemctl", "--user", "daemon-reload"], onFailure: "ignore" },
		]);
		expect(planFor("start", linux)).toEqual([
			{
				kind: "run",
				argv: ["systemctl", "--user", "start", "com.8gent.daemon.service"],
				onFailure: "abort",
			},
		]);
		expect(planFor("stop", linux)).toEqual([
			{
				kind: "run",
				argv: ["systemctl", "--user", "stop", "com.8gent.daemon.service"],
				onFailure: "abort",
			},
		]);
	});

	// Only meaningful where systemctl is absent; on Linux this would drive the real one.
	test.skipIf(process.platform === "linux")(
		"a host without systemd gets the foreground fallback",
		async () => {
			const reason =
				"systemd user services are not available on this machine (common in WSL1 and containers). Run the daemon in the foreground instead: 8gent daemon run";
			expect(await serviceStatus(linux)).toEqual({ state: "unavailable", reason });
			await expect(runOperation("install", linux, () => {})).rejects.toThrow(reason);
		},
	);

	test("status reads systemctl is-active", () => {
		expect(parseStatus("linux", { code: 0, stdout: "active\n" }, true)).toEqual({
			state: "running",
		});
		expect(parseStatus("linux", { code: 3, stdout: "inactive\n" }, true)).toEqual({
			state: "stopped",
		});
		expect(parseStatus("linux", { code: 3, stdout: "failed\n" }, true)).toEqual({
			state: "stopped",
		});
		expect(parseStatus("linux", { code: 3, stdout: "inactive\n" }, false)).toEqual({
			state: "not-installed",
		});
	});
});

describe("Windows Scheduled Task", () => {
	test("task runs at logon for the current user without elevation, output appended to the log", () => {
		expect(scheduledTaskScript(windows)).toBe(`$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''C:\\Users\\ada\\.bun\\bin\\bun.exe'' ''C:\\Users\\ada\\ada''''s code\\bin\\8gent.ts'' ''daemon'' ''run'' 2>&1 | Out-File -FilePath ''C:\\Users\\ada\\.8gent\\daemon.log'' -Append -Encoding utf8"' -WorkingDirectory 'C:\\Users\\ada'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'DESKTOP-1\\ada'
$principal = New-ScheduledTaskPrincipal -UserId 'DESKTOP-1\\ada' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'com.8gent.daemon' -Description 'Eight Agent Daemon - always-on AI agent process' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`);
	});

	const stopScript = `Stop-ScheduledTask -TaskName 'com.8gent.daemon' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq 'C:\\Users\\ada\\.bun\\bin\\bun.exe' -and $_.CommandLine -like '* daemon run' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;

	test("install stops any running copy, re-registers with -Force and starts the task", () => {
		expect(planFor("install", windows)).toEqual([
			{ kind: "mkdir", path: "C:\\Users\\ada\\.8gent" },
			{ kind: "powershell", script: stopScript },
			{ kind: "powershell", script: scheduledTaskScript(windows) },
			{ kind: "powershell", script: "Start-ScheduledTask -TaskName 'com.8gent.daemon'\n" },
		]);
	});

	test("uninstall and stop also end the daemon process the task host spawned", () => {
		expect(planFor("uninstall", windows)).toEqual([
			{ kind: "powershell", script: stopScript },
			{
				kind: "powershell",
				script:
					"Unregister-ScheduledTask -TaskName 'com.8gent.daemon' -Confirm:$false -ErrorAction SilentlyContinue\n",
			},
		]);
		expect(planFor("stop", windows)).toEqual([{ kind: "powershell", script: stopScript }]);
		expect(planFor("start", windows)).toEqual([
			{ kind: "powershell", script: "Start-ScheduledTask -TaskName 'com.8gent.daemon'\n" },
		]);
	});

	test("status maps the task state", () => {
		expect(parseStatus("win32", { code: 0, stdout: "Running\r\n" }, false)).toEqual({
			state: "running",
		});
		expect(parseStatus("win32", { code: 0, stdout: "Ready\r\n" }, false)).toEqual({
			state: "stopped",
		});
		expect(parseStatus("win32", { code: 0, stdout: "NotInstalled\r\n" }, false)).toEqual({
			state: "not-installed",
		});
	});

	test("scripts are passed as UTF-16LE base64 so no quoting reaches the command line", () => {
		expect(powershellArgv("Get-Date")).toEqual([
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			"RwBlAHQALQBEAGEAdABlAA==",
		]);
	});
});

describe("8gent daemon", () => {
	test("status lines a user reads", () => {
		expect(describeState({ state: "running", pid: 7 })).toBe("running (pid 7)");
		expect(describeState({ state: "stopped" })).toBe("installed, not running");
		expect(describeState({ state: "not-installed" })).toBe("not installed");
		expect(describeState({ state: "unavailable", reason: "no systemd." })).toBe(
			"unavailable. no systemd.",
		);
	});

	test("an unknown subcommand prints usage and fails", async () => {
		expect(await daemonCommand(["bogus"], [])).toBe(1);
		expect(await daemonCommand([], [])).toBe(0);
	});
});
