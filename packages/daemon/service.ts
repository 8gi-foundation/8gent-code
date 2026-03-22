/**
 * Service - OS service installer for the daemon.
 *
 * macOS: launchd plist in ~/Library/LaunchAgents/
 * Linux: systemd user unit in ~/.config/systemd/user/
 */

import { existsSync } from "fs";

const SERVICE_NAME = "com.8gent.daemon";
const DESCRIPTION = "Eight Agent Daemon - always-on AI agent process";

function getBunPath(): string {
  return Bun.which("bun") || "/usr/local/bin/bun";
}

function getDaemonScript(): string {
  return `${import.meta.dir}/index.ts`;
}

// ----- macOS (launchd) -----

function launchdPlistPath(): string {
  return `${process.env.HOME}/Library/LaunchAgents/${SERVICE_NAME}.plist`;
}

function generatePlist(): string {
  const bun = getBunPath();
  const script = getDaemonScript();
  const logPath = `${process.env.HOME}/.8gent/daemon.log`;
  const errPath = `${process.env.HOME}/.8gent/daemon-error.log`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>run</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
  <key>WorkingDirectory</key>
  <string>${import.meta.dir}</string>
</dict>
</plist>`;
}

// ----- Linux (systemd) -----

function systemdUnitPath(): string {
  return `${process.env.HOME}/.config/systemd/user/${SERVICE_NAME}.service`;
}

function generateUnit(): string {
  const bun = getBunPath();
  const script = getDaemonScript();

  return `[Unit]
Description=${DESCRIPTION}
After=network.target

[Service]
Type=simple
ExecStart=${bun} run ${script}
Restart=always
RestartSec=5
WorkingDirectory=${import.meta.dir}
StandardOutput=append:${process.env.HOME}/.8gent/daemon.log
StandardError=append:${process.env.HOME}/.8gent/daemon-error.log

[Install]
WantedBy=default.target`;
}

// ----- Commands -----

const isMac = process.platform === "darwin";

async function install(): Promise<void> {
  // Ensure log directory exists
  const logDir = `${process.env.HOME}/.8gent`;
  if (!existsSync(logDir)) {
    await Bun.spawn(["mkdir", "-p", logDir]).exited;
  }

  if (isMac) {
    const path = launchdPlistPath();
    await Bun.write(path, generatePlist());
    console.log(`[service] installed launchd plist: ${path}`);
    console.log(`[service] run: launchctl load ${path}`);
  } else {
    const dir = `${process.env.HOME}/.config/systemd/user`;
    if (!existsSync(dir)) {
      await Bun.spawn(["mkdir", "-p", dir]).exited;
    }
    const path = systemdUnitPath();
    await Bun.write(path, generateUnit());
    await Bun.spawn(["systemctl", "--user", "daemon-reload"]).exited;
    console.log(`[service] installed systemd unit: ${path}`);
    console.log(`[service] run: systemctl --user enable --now ${SERVICE_NAME}`);
  }
}

async function uninstall(): Promise<void> {
  if (isMac) {
    const path = launchdPlistPath();
    if (existsSync(path)) {
      await Bun.spawn(["launchctl", "unload", path]).exited;
      await Bun.spawn(["rm", path]).exited;
      console.log(`[service] uninstalled launchd plist: ${path}`);
    } else {
      console.log("[service] plist not found, nothing to uninstall");
    }
  } else {
    const path = systemdUnitPath();
    if (existsSync(path)) {
      await Bun.spawn(["systemctl", "--user", "disable", "--now", SERVICE_NAME]).exited;
      await Bun.spawn(["rm", path]).exited;
      await Bun.spawn(["systemctl", "--user", "daemon-reload"]).exited;
      console.log(`[service] uninstalled systemd unit: ${path}`);
    } else {
      console.log("[service] unit file not found, nothing to uninstall");
    }
  }
}

async function start(): Promise<void> {
  if (isMac) {
    await Bun.spawn(["launchctl", "load", launchdPlistPath()]).exited;
  } else {
    await Bun.spawn(["systemctl", "--user", "start", SERVICE_NAME]).exited;
  }
  console.log("[service] started");
}

async function stop(): Promise<void> {
  if (isMac) {
    await Bun.spawn(["launchctl", "unload", launchdPlistPath()]).exited;
  } else {
    await Bun.spawn(["systemctl", "--user", "stop", SERVICE_NAME]).exited;
  }
  console.log("[service] stopped");
}

async function status(): Promise<void> {
  if (isMac) {
    const proc = Bun.spawn(["launchctl", "list", SERVICE_NAME], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    console.log(out || "[service] not loaded");
  } else {
    const proc = Bun.spawn(["systemctl", "--user", "status", SERVICE_NAME], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    console.log(out);
  }
}

// ----- CLI entry -----

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { install, uninstall, start, stop, status };

if (command && commands[command]) {
  commands[command]().catch((err) => {
    console.error(`[service] ${command} failed:`, err);
    process.exit(1);
  });
} else if (import.meta.main) {
  console.log(`Usage: bun run service.ts <install|uninstall|start|stop|status>`);
}
