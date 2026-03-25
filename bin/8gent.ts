#!/usr/bin/env bun
/**
 * 8gent Code - Main CLI Entry Point
 *
 * The terminal-first agentic coding experience.
 * "Never hit usage caps again"
 */

import * as path from "path";
import * as fs from "fs";

const VERSION = "1.0.1";
const BANNER = `
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   █████╗  ██████╗ ███████╗███╗   ██╗████████╗             ║
║  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝             ║
║  ╚█████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║                ║
║  ██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║                ║
║  ╚█████╔╝╚██████╔╝███████╗██║ ╚████║   ██║                ║
║   ╚════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   CODE         ║
║                                                           ║
║   Never hit usage caps again™                             ║
║   AST-first code exploration • 40%+ token savings         ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`;

const HELP = `
8gent Code v${VERSION}

USAGE:
  8gent <command> [options]

COMMANDS:
  tui                         Launch interactive TUI (auto-spawns dock pet)
  pet                         Launch Lil Eight dock companion only
  chat <message>              Send a message (non-interactive, pipe-friendly)
  agent <sub>                 Multi-agent orchestration
  session <sub>               Session history & resume
  preferences <sub>           Get/set user preferences
  memory <sub>                Remember, recall, forget
  onboard                     Run onboarding (auto-detect + configure)
  status                      Show full system status
  init                        Initialize 8gent in current directory
  outline <file>              Get symbol outline of a file
  symbol <file>::<name>       Get source code for a specific symbol
  search <query>              Search for symbols across files
  benchmark                   Run efficiency benchmarks
  infinite <task>             Run task in autonomous infinite mode
  auth <sub>                  Authentication (login, logout, status)

AGENT COMMANDS:
  agent list                  List active sub-agents
  agent spawn <persona> <task>  Spawn a BMAD agent (winston/larry/curly/mo/doc)
  agent kill <id>             Kill a sub-agent
  agent message <id> <msg>    Send message to a sub-agent
  agent auto [on|off]         Toggle auto-spawn permission
  agent status                Show orchestration status

SESSION COMMANDS:
  session list [--limit=N]    List recent sessions
  session resume <id>         Resume a session by ID
  session checkpoint          Save current session checkpoint
  session compact             Compress current session history

PREFERENCES COMMANDS:
  preferences get             Show all preferences
  preferences set <key> <val> Set a preference
  preferences sync            Sync with cloud (requires auth)
  preferences reset           Reset to defaults

MEMORY COMMANDS:
  memory recall <query>       Search memory
  memory remember <fact>      Store a memory
  memory forget <id>          Delete a memory
  memory stats                Show memory statistics

OPTIONS:
  -h, --help     Show this help message
  -v, --version  Show version
  --json         Output as JSON (machine-readable)
  --yes          Auto-approve all prompts (non-interactive)
  --model=<m>    Override model (e.g., --model=qwen3:14b)
  --provider=<p> Override provider (e.g., --provider=ollama)
  --cwd=<dir>    Override working directory
  --infinite     Enable infinite mode (autonomous until done)
  --pet          Also spawn Lil Eight dock companion (auto with tui)
  --no-pet       Disable dock pet auto-spawn

EXAMPLES:
  # Non-interactive chat (pipe-friendly)
  8gent chat "Fix the auth middleware" --json
  echo "Explain this code" | 8gent chat --stdin

  # Multi-agent orchestration
  8gent agent spawn winston "Design the multi-tenant schema"
  8gent agent list --json
  8gent agent message winston-1 "Focus on data isolation"

  # Session management
  8gent session list --json --limit=5
  8gent session resume sess_abc123

  # Preferences
  8gent preferences get --json
  8gent preferences set model qwen3:14b

  # Memory
  8gent memory recall "auth middleware" --json
  8gent memory remember "Uses JWT with RS256 for auth"

  # Autonomous execution
  8gent infinite "Build a REST API for user management"
  8gent chat "Add tests" --yes --infinite

MACHINE INTEGRATION:
  All commands support --json for structured output.
  Use --yes for non-interactive execution (no prompts).
  Exit codes: 0=success, 1=error, 2=auth required.
  Designed for orchestration by Claude Code, Cursor, aider, etc.

Learn more: https://github.com/PodJamz/8gent-code
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(BANNER);
    console.log(HELP);
    return;
  }

  // No args = launch TUI with pet (the default experience)
  if (args.length === 0) {
    await tuiCommand([]);
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    console.log(`8gent Code v${VERSION}`);
    return;
  }

  // Check for --infinite flag (can be used with any command)
  // Supports: --infinite, -infinite, -i
  const hasInfiniteFlag = args.includes("--infinite") || args.includes("-infinite") || args.includes("-i");
  if (hasInfiniteFlag) {
    // Import and enable infinite mode globally
    const { enableInfiniteMode } = await import("../packages/permissions");
    enableInfiniteMode();
    // Remove the flag from args
    const filteredArgs = args.filter(a => a !== "--infinite" && a !== "-infinite" && a !== "-i");
    args.length = 0;
    args.push(...filteredArgs);
  }

  // If just --infinite with no command, launch TUI in infinite mode
  if (args.length === 0 && hasInfiniteFlag) {
    args.push("tui");
  }

  // Handle --pet / -pet as standalone (same as 8gent pet start)
  if (args.includes("--pet") || args.includes("-pet")) {
    const filtered = args.filter(a => a !== "--pet" && a !== "-pet");
    if (filtered.length === 0) {
      await petCommand(["start"]);
      return;
    }
    // Otherwise it's a flag on another command - handled by tuiCommand
  }

  const command = args[0];
  const restArgs = args.slice(1);

  switch (command) {
    case "init":
      await initCommand(restArgs);
      break;

    case "outline":
      await outlineCommand(restArgs);
      break;

    case "symbol":
      await symbolCommand(restArgs);
      break;

    case "search":
      await searchCommand(restArgs);
      break;

    case "benchmark":
      await benchmarkCommand(restArgs);
      break;

    case "demo":
      await demoCommand(restArgs);
      break;

    case "tui":
      await tuiCommand(restArgs);
      break;

    case "pet":
      await petCommand(restArgs);
      break;

    case "infinite":
      await infiniteCommand(restArgs);
      break;

    case "chat":
      await chatCommand(restArgs);
      break;

    case "agent":
      await agentCommand(restArgs);
      break;

    case "session":
      await sessionCommand(restArgs);
      break;

    case "preferences":
      await preferencesCommand(restArgs);
      break;

    case "memory":
      await memoryCommand(restArgs);
      break;

    case "airdrop":
    case "drop":
      await airdropCommand(restArgs);
      break;

    case "onboard":
      await onboardCommand(restArgs);
      break;

    case "status":
      await statusCommand(restArgs);
      break;

    case "auth":
      await authCommand(restArgs);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(`Run '8 --help' for usage information.`);
      process.exit(1);
  }
}

async function initCommand(args: string[]) {
  console.log(BANNER);
  console.log("Initializing 8gent Code...\n");

  const configPath = path.join(process.cwd(), ".8gent");
  const indexPath = path.join(configPath, "index");

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configPath, { recursive: true });
    fs.mkdirSync(indexPath, { recursive: true });

    const config = {
      version: VERSION,
      initialized: new Date().toISOString(),
      settings: {
        preferAstFirst: true,
        autoIndex: true,
        indexPatterns: ["**/*.{ts,tsx,js,jsx}"],
        ignorePatterns: ["**/node_modules/**", "**/dist/**"],
      },
    };

    fs.writeFileSync(
      path.join(configPath, "config.json"),
      JSON.stringify(config, null, 2)
    );

    console.log("✅ Created .8gent directory");
    console.log("✅ Created config.json");
    console.log("\n🚀 8gent Code is ready!");
    console.log("   Run '8gent outline <file>' to get started.");
  } else {
    console.log("8gent is already initialized in this directory.");
  }
}

async function outlineCommand(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: 8gent outline <file>");
    process.exit(1);
  }

  const filePath = args[0];
  const isJson = args.includes("--json");

  // Dynamic import to avoid loading heavy modules for help
  const { parseTypeScriptFile } = await import("../packages/ast-index/typescript-parser");

  const start = performance.now();
  const outline = parseTypeScriptFile(filePath);
  const time = performance.now() - start;

  // Calculate savings
  const fileSize = fs.statSync(filePath).size;
  const fullTokens = Math.ceil(fileSize / 4);
  const outlineJson = JSON.stringify(outline.symbols);
  const outlineTokens = Math.ceil(outlineJson.length / 4);
  const saved = fullTokens - outlineTokens;
  const percent = ((saved / fullTokens) * 100).toFixed(1);

  if (isJson) {
    console.log(JSON.stringify({
      filePath: outline.filePath,
      language: outline.language,
      symbolCount: outline.symbols.length,
      symbols: outline.symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        lines: `${s.startLine}-${s.endLine}`,
        signature: s.signature,
      })),
      efficiency: {
        traditionalTokens: fullTokens,
        astTokens: outlineTokens,
        tokensSaved: saved,
        savingsPercent: parseFloat(percent),
      },
    }, null, 2));
  } else {
    console.log(`\n📄 ${path.basename(filePath)} (${outline.language})`);
    console.log(`   ${outline.symbols.length} symbols • ${time.toFixed(1)}ms • ${percent}% token savings\n`);

    for (const symbol of outline.symbols) {
      const icon = getSymbolIcon(symbol.kind);
      console.log(`   ${icon} ${symbol.kind.padEnd(10)} ${symbol.name}`);
      if (symbol.signature) {
        console.log(`      └─ ${symbol.signature.slice(0, 60)}${symbol.signature.length > 60 ? "..." : ""}`);
      }
    }

    console.log(`\n   💡 Saved ${saved.toLocaleString()} tokens (${percent}% less than full file read)`);
  }
}

async function symbolCommand(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: 8gent symbol <file>::<symbolName>");
    process.exit(1);
  }

  const symbolId = args[0];
  const contextLines = parseInt(args.find(a => a.startsWith("--context="))?.split("=")[1] || "0");

  const separatorIndex = symbolId.lastIndexOf("::");
  if (separatorIndex === -1) {
    console.error("Invalid symbol ID. Format: path/to/file.ts::symbolName");
    process.exit(1);
  }

  const filePath = symbolId.slice(0, separatorIndex);
  const symbolName = symbolId.slice(separatorIndex + 2);

  const { parseTypeScriptFile, getSymbolSource } = await import("../packages/ast-index/typescript-parser");

  const outline = parseTypeScriptFile(filePath);
  const symbol = outline.symbols.find(s => s.name === symbolName);

  if (!symbol) {
    console.error(`Symbol '${symbolName}' not found in ${filePath}`);
    console.log("\nAvailable symbols:");
    for (const s of outline.symbols) {
      console.log(`  • ${s.name} (${s.kind})`);
    }
    process.exit(1);
  }

  const source = getSymbolSource(filePath, symbol.startLine, symbol.endLine, contextLines);

  // Calculate savings
  const fileSize = fs.statSync(filePath).size;
  const fullTokens = Math.ceil(fileSize / 4);
  const symbolTokens = Math.ceil(source.length / 4);
  const saved = fullTokens - symbolTokens;
  const percent = ((saved / fullTokens) * 100).toFixed(1);

  console.log(`\n${getSymbolIcon(symbol.kind)} ${symbol.name} (${symbol.kind})`);
  console.log(`   Lines ${symbol.startLine}-${symbol.endLine} in ${path.basename(filePath)}`);
  if (symbol.signature) {
    console.log(`   ${symbol.signature}`);
  }
  console.log(`\n${"─".repeat(60)}\n`);
  console.log(source);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`\n   💡 Saved ${saved.toLocaleString()} tokens (${percent}% less than full file)`);
}

async function searchCommand(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: 8gent search <query> [--kinds=function,class] [--dir=src/]");
    process.exit(1);
  }

  const query = args[0];
  const kindsArg = args.find(a => a.startsWith("--kinds="))?.split("=")[1];
  const dirArg = args.find(a => a.startsWith("--dir="))?.split("=")[1] || ".";
  const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "20");

  console.log(`\n🔍 Searching for "${query}"...\n`);

  const { glob } = await import("glob");
  const { parseTypeScriptFile } = await import("../packages/ast-index/typescript-parser");

  const files = await glob("**/*.{ts,tsx,js,jsx}", {
    cwd: dirArg,
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const kinds = kindsArg?.split(",") || null;
  const queryLower = query.toLowerCase();
  const matches: { symbol: any; file: string }[] = [];

  for (const file of files) {
    if (matches.length >= limit) break;
    try {
      const outline = parseTypeScriptFile(file);
      for (const symbol of outline.symbols) {
        if (matches.length >= limit) break;
        if (kinds && !kinds.includes(symbol.kind)) continue;
        if (
          symbol.name.toLowerCase().includes(queryLower) ||
          symbol.signature?.toLowerCase().includes(queryLower)
        ) {
          matches.push({ symbol, file });
        }
      }
    } catch {
      // Skip unparseable files
    }
  }

  if (matches.length === 0) {
    console.log("   No matches found.");
  } else {
    for (const { symbol, file } of matches) {
      const icon = getSymbolIcon(symbol.kind);
      console.log(`   ${icon} ${symbol.name.padEnd(30)} ${symbol.kind.padEnd(10)} ${path.relative(process.cwd(), file)}`);
    }
    console.log(`\n   Found ${matches.length} match${matches.length === 1 ? "" : "es"}`);
  }
}

async function benchmarkCommand(args: string[]) {
  // Run the benchmark script
  const benchmarkPath = path.join(__dirname, "../scripts/benchmark.ts");
  const { spawn } = await import("child_process");

  const proc = spawn("bun", ["run", benchmarkPath, ...args], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });

  proc.on("exit", (code) => process.exit(code || 0));
}

async function demoCommand(args: string[]) {
  // Run the demo script
  const demoPath = path.join(__dirname, "../scripts/demo-savings.ts");
  const { spawn } = await import("child_process");

  const proc = spawn("bun", ["run", demoPath, ...args], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });

  proc.on("exit", (code) => process.exit(code || 0));
}

// Spawn Lil Eight dock pet (non-blocking, idempotent)
async function spawnPet(sessionId?: string) {
  const { spawn: spawnProc, execSync } = await import("child_process");
  const platform = process.platform; // darwin, win32, linux

  // macOS: native Swift dock pet
  // Windows/Linux: terminal-rendered pet (future: Electron/Tauri)
  if (platform !== "darwin") {
    console.log("\x1b[36m[pet] Lil Eight terminal mode (cross-platform)\x1b[0m");

    // Start terminal pet in background
    try {
      const petPath = path.join(__dirname, "../packages/pet/terminal-pet.ts");
      if (fs.existsSync(petPath)) {
        const { TerminalPet } = await import(petPath);
        const pet = new TerminalPet({ label: sessionId || "eight" });

        const rows = process.stdout.rows || 24;
        const petHeight = 8;

        pet.onRender = (lines: string[], x: number, label: string) => {
          const startRow = rows - petHeight - 1;
          const padding = " ".repeat(Math.max(0, x));
          process.stdout.write("\x1b7");
          for (let i = 0; i < lines.length; i++) {
            process.stdout.write(`\x1b[${startRow + i};1H\x1b[2K${padding}${lines[i]}`);
          }
          process.stdout.write(`\x1b[${startRow + lines.length};1H\x1b[2K${" ".repeat(Math.max(0, x + 4))}\x1b[2m${label}\x1b[0m`);
          process.stdout.write("\x1b8");
        };

        pet.start();
        process.on("exit", () => pet.stop());
      }
    } catch (e) {
      // Terminal pet failed - continue without it
    }

    // Register with mesh
    try {
      const home = process.env.HOME || process.env.USERPROFILE || "~";
      const meshDir = path.join(home, ".8gent", "mesh");
      fs.mkdirSync(meshDir, { recursive: true });
      const registryPath = path.join(meshDir, "registry.json");
      let registry: Record<string, any> = {};
      try { registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")); } catch {}
      const agentId = sessionId || `eight-tui-${process.pid}`;
      registry[agentId] = {
        id: agentId, type: "eight", name: "TUI", pid: process.pid,
        cwd: process.cwd(), capabilities: ["code", "orchestrate"],
        startedAt: Date.now(), lastHeartbeat: Date.now(), channel: "terminal"
      };
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch {}
    return;
  }

  // Generate companion and write JSON for dock pet to read
  try {
    const { generateCompanion } = await import("../packages/pet/companion.js");
    const companion = generateCompanion(sessionId || `session-${Date.now()}`);
    const home = process.env.HOME || "~";
    fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".8gent", "active-companion.json"), JSON.stringify({
      fullName: companion.fullName, species: companion.species, element: companion.element,
      rarity: companion.rarity, accessory: companion.accessory, shiny: companion.shiny,
      palette: companion.palette, lore: companion.lore,
    }, null, 2));
  } catch {}

  const lilEightScript = path.join(__dirname, "lil-eight.sh");

  // Kill existing pets, then spawn fresh
  try { execSync("pkill -f LilEight 2>/dev/null", { stdio: "pipe" }); } catch {}

  // Spawn new pet
  {
    // Not running - spawn it
    if (fs.existsSync(lilEightScript)) {
      const pet = spawnProc("bash", [lilEightScript, "start"], {
        detached: true,
        stdio: "ignore",
      });
      pet.unref();
      console.log("\x1b[36m[pet] Lil Eight spawned on Dock\x1b[0m");
    } else {
      // Try build first
      const buildScript = path.join(__dirname, "../apps/lil-eight/build.sh");
      if (fs.existsSync(buildScript)) {
        console.log("\x1b[36m[pet] Building Lil Eight...\x1b[0m");
        try {
          execSync(`bash "${buildScript}"`, { stdio: "pipe" });
          const pet = spawnProc("bash", [lilEightScript, "start"], {
            detached: true,
            stdio: "ignore",
          });
          pet.unref();
          console.log("\x1b[36m[pet] Lil Eight spawned on Dock\x1b[0m");
        } catch (e) {
          console.log("\x1b[33m[pet] Could not build Lil Eight\x1b[0m");
        }
      }
    }
  }

  // Register this session with the Agent Mesh
  try {
    const meshDir = path.join(process.env.HOME || "~", ".8gent", "mesh");
    const registryPath = path.join(meshDir, "registry.json");
    fs.mkdirSync(meshDir, { recursive: true });

    const agentId = sessionId || `eight-tui-${process.pid}`;
    let registry: Record<string, any> = {};
    try { registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")); } catch {}

    registry[agentId] = {
      id: agentId,
      type: "eight",
      name: "TUI",
      pid: process.pid,
      cwd: process.cwd(),
      capabilities: ["code", "orchestrate", "memory", "tools"],
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      channel: "terminal",
    };

    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    // Clean up on exit
    const cleanup = () => {
      try {
        const reg = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
        delete reg[agentId];
        fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
      } catch {}
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  } catch {}
}

async function tuiCommand(args: string[]) {
  console.log(BANNER);

  // Auto-spawn pet unless --no-pet
  const noPet = args.includes("--no-pet");
  const filteredArgs = args.filter(a => a !== "--no-pet" && a !== "--pet");

  if (!noPet) {
    await spawnPet();
  }

  console.log("Launching TUI...\n");

  const { spawn } = await import("child_process");
  const tuiPath = path.join(__dirname, "../apps/tui/src/index.tsx");

  const proc = spawn("bun", ["run", tuiPath, ...filteredArgs], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });

  proc.on("exit", (code) => process.exit(code || 0));
}

async function airdropCommand(args: string[]) {
  if (process.platform !== "darwin") {
    console.log("AirDrop is macOS only. Use 8gent send for cross-platform sharing.");
    return;
  }

  if (args.length === 0) {
    console.log("Usage: 8gent airdrop <file|text>");
    console.log("  8gent airdrop ./report.pdf     - AirDrop a file");
    console.log("  8gent airdrop \"Hello from 8gent\" - AirDrop text as a note");
    console.log('  8gent drop ./file.txt          - shorthand');
    return;
  }

  const target = args.join(" ");
  const { execSync } = await import("child_process");

  // Check if it's a file path
  if (fs.existsSync(target) || fs.existsSync(path.resolve(target))) {
    const resolved = path.resolve(target);
    console.log(`AirDropping: ${resolved}`);

    // Use osascript to trigger AirDrop via Finder
    const script = `
      tell application "Finder"
        activate
        set theFile to POSIX file "${resolved}" as alias
        set theWindow to make new Finder window
        set target of theWindow to theFile
      end tell
      tell application "System Events"
        tell process "Finder"
          delay 0.5
          click menu item "AirDrop" of menu "Go" of menu bar 1
        end tell
      end tell
    `;

    // Simpler approach: open the share sheet via NSSharingService from a helper
    const swiftHelper = `
      import Cocoa
      let url = URL(fileURLWithPath: "${resolved}")
      if let service = NSSharingService(named: .sendViaAirDrop) {
        if service.canPerform(withItems: [url]) {
          service.perform(withItems: [url])
          RunLoop.main.run(until: Date(timeIntervalSinceNow: 30))
        } else {
          print("AirDrop not available - check Bluetooth and WiFi")
          exit(1)
        }
      }
    `;

    const tmpSwift = "/tmp/eight-airdrop.swift";
    fs.writeFileSync(tmpSwift, swiftHelper);
    try {
      execSync(`swiftc -o /tmp/eight-airdrop -framework Cocoa "${tmpSwift}" && /tmp/eight-airdrop`, {
        stdio: "inherit",
        timeout: 60000,
      });
    } catch {
      console.log("AirDrop window closed or timed out");
    }
  } else {
    // It's text - write to temp file and AirDrop
    const tmpFile = `/tmp/eight-note-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, target);
    console.log(`AirDropping note: "${target.slice(0, 50)}..."`);
    await airdropCommand([tmpFile]);
  }
}

async function petCommand(args: string[]) {
  const subCmd = args[0] || "start";
  const { execSync } = await import("child_process");
  const lilEightScript = path.join(__dirname, "lil-eight.sh");

  if (!fs.existsSync(lilEightScript)) {
    console.log("Building Lil Eight first...");
    const buildScript = path.join(__dirname, "../apps/lil-eight/build.sh");
    execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  }

  switch (subCmd) {
    case "start":
    case "open":
      await spawnPet();
      break;
    case "stop":
    case "kill":
      try { execSync("pkill -f LilEight"); console.log("Lil Eight stopped"); } catch { console.log("Not running"); }
      break;
    case "restart":
      try { execSync("pkill -f LilEight"); } catch {}
      setTimeout(() => spawnPet(), 1000);
      break;
    case "build":
      execSync(`bash "${path.join(__dirname, "../apps/lil-eight/build.sh")}"`, { stdio: "inherit" });
      break;
    case "log":
    case "logs":
      const { spawn: sp } = await import("child_process");
      const logPath = path.join(process.env.HOME || "~", ".8gent", "lil-eight.log");
      sp("tail", ["-f", logPath], { stdio: "inherit" });
      break;
    case "status":
      try {
        execSync("pgrep -f LilEight", { stdio: "pipe" });
        console.log("Lil Eight is running");
        const logP = path.join(process.env.HOME || "~", ".8gent", "lil-eight.log");
        if (fs.existsSync(logP)) {
          const lines = fs.readFileSync(logP, "utf-8").trim().split("\n").slice(-3);
          lines.forEach(l => console.log(`  ${l}`));
        }
      } catch { console.log("Lil Eight is not running"); }
      break;
    default:
      console.log("Usage: 8gent pet [start|stop|restart|build|log|status]");
  }
}

async function infiniteCommand(args: string[]) {
  console.log(BANNER);
  console.log("🔄 INFINITE MODE - Autonomous execution until done\n");

  if (args.length === 0) {
    console.error("Usage: 8gent infinite <task description>");
    console.log('\nExample: 8gent infinite "Build a Next.js landing page with dark theme"');
    process.exit(1);
  }

  const task = args.join(" ");
  const maxIterations = parseInt(args.find(a => a.startsWith("--max="))?.split("=")[1] || "100");
  const maxTimeMin = parseInt(args.find(a => a.startsWith("--time="))?.split("=")[1] || "30");

  console.log(`Task: ${task}`);
  console.log(`Max iterations: ${maxIterations}`);
  console.log(`Max time: ${maxTimeMin} minutes`);
  console.log("─".repeat(60));
  console.log("");

  try {
    const { runInfinite, formatInfiniteState } = await import("../packages/infinite");

    const state = await runInfinite(task, {
      maxIterations,
      maxTimeMs: maxTimeMin * 60 * 1000,
      workingDirectory: process.cwd(),
      onIteration: (s) => {
        process.stdout.write(`\r${formatInfiniteState(s)}`);
      },
      onErrorRecovered: (err, s) => {
        console.log(`\n⚠️  Error recovered: ${err.message.slice(0, 50)}...`);
      },
    });

    console.log("\n");
    console.log("─".repeat(60));

    if (state.phase === "complete") {
      console.log("✅ TASK COMPLETED SUCCESSFULLY");
      console.log(`   Iterations: ${state.iteration}`);
      console.log(`   Time: ${(state.elapsedMs / 1000).toFixed(1)}s`);
      console.log(`   Files changed: ${state.filesChanged.length}`);
      console.log(`   Errors recovered: ${state.recoveredErrors.length}`);
    } else {
      console.log("❌ TASK FAILED OR TIMED OUT");
      console.log(`   Phase: ${state.phase}`);
      console.log(`   Iterations: ${state.iteration}`);
      if (state.recoveredErrors.length > 0) {
        console.log(`   Last error: ${state.recoveredErrors.slice(-1)[0]?.error.message}`);
      }
    }
  } catch (err) {
    console.error("Failed to run infinite mode:", err);
    process.exit(1);
  }
}

async function authCommand(args: string[]) {
  const subcommand = args[0] || "help";

  switch (subcommand) {
    case "login": {
      console.log("Authenticating with 8gent...\n");

      const { login } = await import("../packages/auth");

      const state = await login({
        onDeviceCode: (code, uri) => {
          console.log("Opening browser for authentication...\n");
          console.log(`  If the browser doesn't open, visit:`);
          console.log(`  ${uri}\n`);
          console.log(`  Enter code: ${code}\n`);
          console.log("Waiting for approval...");
        },
        onPollAttempt: (attempt) => {
          process.stdout.write(`\rPolling... (attempt ${attempt})`);
        },
        onLoginSuccess: (user) => {
          console.log(`\n\nLogged in as @${user.githubUsername} (${user.plan} plan)`);
          console.log(`Email: ${user.email}`);
        },
        onLoginError: (error) => {
          console.error(`\nLogin failed: ${error}`);
        },
      });

      if (state.state !== "authenticated") {
        process.exit(1);
      }
      break;
    }

    case "logout": {
      const { logout } = await import("../packages/auth");
      await logout();
      console.log("Logged out successfully.");
      break;
    }

    case "status": {
      const { initAuth } = await import("../packages/auth");
      const state = await initAuth();

      if (state.state === "authenticated") {
        const { user, tokenExpiresAt } = state;
        console.log(`Logged in as @${user.githubUsername}`);
        console.log(`  Email:   ${user.email}`);
        console.log(`  Plan:    ${user.plan}`);
        console.log(`  Name:    ${user.displayName}`);

        const expiresIn = tokenExpiresAt - Date.now();
        if (expiresIn > 0) {
          const hours = Math.floor(expiresIn / (1000 * 60 * 60));
          const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60));
          console.log(`  Token:   expires in ${hours}h ${minutes}m`);
        } else {
          console.log(`  Token:   expired (will refresh on next use)`);
        }
      } else {
        console.log("Not logged in.");
        console.log("Run `8gent auth login` to authenticate with GitHub.");
      }
      break;
    }

    case "whoami": {
      const { initAuth } = await import("../packages/auth");
      const state = await initAuth();

      if (state.state === "authenticated") {
        console.log(`@${state.user.githubUsername} (${state.user.plan})`);
      } else {
        console.log("anonymous");
      }
      break;
    }

    case "help":
    default:
      console.log(`
8gent auth — Authentication Commands

USAGE:
  8gent auth <subcommand>

SUBCOMMANDS:
  login     Authenticate with GitHub (device code flow)
  logout    Clear stored credentials
  status    Show current auth state and usage
  whoami    Quick identity check (one line)
`);
      break;
  }
}

// ── Helper: Parse global flags ────────────────────────────────────

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      flags[key] = val || true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ── Chat Command (non-interactive, pipe-friendly) ─────────────────

async function chatCommand(args: string[]) {
  const { flags, rest } = parseFlags(args);
  const isJson = !!flags.json;
  const useStdin = !!flags.stdin;
  const model = (flags.model as string) || undefined;
  const provider = (flags.provider as string) || undefined;
  const cwd = (flags.cwd as string) || process.cwd();

  let message = rest.join(" ");

  // Read from stdin if --stdin flag or no message provided
  if (useStdin || (!message && !process.stdin.isTTY)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    message = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!message) {
    console.error("Usage: 8gent chat <message> [--json] [--model=<m>] [--stdin]");
    process.exit(1);
  }

  try {
    const { Agent } = await import("../packages/eight/agent");

    const agent = new Agent({
      model: model || "qwen3.5:latest",
      runtime: provider || "ollama",
      workingDirectory: cwd,
      maxTurns: 30,
    });

    const response = await agent.chat(message);
    await agent.cleanup();

    if (isJson) {
      jsonOut({
        success: true,
        message,
        response,
        model: model || "qwen3.5:latest",
        provider: provider || "ollama",
      });
    } else {
      console.log(response);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      jsonOut({ success: false, error: errMsg });
    } else {
      console.error(`Error: ${errMsg}`);
    }
    process.exit(1);
  }
}

// ── Agent Command (multi-agent orchestration) ─────────────────────

async function agentCommand(args: string[]) {
  const { flags, rest } = parseFlags(args);
  const isJson = !!flags.json;
  const sub = rest[0] || "list";

  const { getOrchestratorBus } = await import("../packages/orchestration/orchestrator-bus");
  const { getPersona, listPersonas } = await import("../packages/orchestration/personas");
  const bus = getOrchestratorBus();

  switch (sub) {
    case "list": {
      const agents = bus.getAgents();
      if (isJson) {
        jsonOut({
          count: agents.length,
          agents: agents.map(a => ({
            id: a.id,
            persona: a.persona.id,
            name: a.persona.name,
            role: a.persona.role,
            task: a.task,
            status: a.status,
            spawnedAt: a.spawnedAt.toISOString(),
          })),
        });
      } else {
        if (agents.length === 0) {
          console.log("No active sub-agents.");
        } else {
          for (const a of agents) {
            console.log(`${a.persona.icon} ${a.id} — ${a.persona.name} (${a.persona.role})`);
            console.log(`  Task: ${a.task}`);
            console.log(`  Status: ${a.status}`);
          }
        }
      }
      break;
    }

    case "spawn": {
      const personaId = rest[1];
      const task = rest.slice(2).join(" ");
      if (!personaId) {
        const personas = listPersonas();
        if (isJson) {
          jsonOut({ error: "persona required", available: personas.map(p => ({ id: p.id, name: p.name, role: p.role })) });
        } else {
          console.log("Usage: 8gent agent spawn <persona> <task>\n");
          console.log("Available personas:");
          for (const p of personas) {
            console.log(`  ${p.icon} ${p.id.padEnd(10)} ${p.name} — ${p.role}`);
          }
        }
        process.exit(1);
      }

      const persona = getPersona(personaId);
      if (!persona) {
        console.error(`Unknown persona: ${personaId}`);
        process.exit(1);
      }

      const request = bus.requestSpawn(personaId, task || "General assistance", "CLI spawn");

      if (isJson) {
        jsonOut({ success: true, requestId: request.id, persona: personaId, task, status: request.status });
      } else {
        console.log(`Spawn request: ${persona.icon} ${persona.name} (${persona.role})`);
        console.log(`Task: ${task || "General assistance"}`);
        console.log(`Status: ${request.status}`);
      }
      break;
    }

    case "kill": {
      const killId = rest[1];
      if (!killId) {
        console.error("Usage: 8gent agent kill <agent-id>");
        process.exit(1);
      }
      const killed = bus.killAgent(killId);
      if (isJson) {
        jsonOut({ success: !!killed, agentId: killId });
      } else {
        console.log(killed ? `Killed: ${killed.persona.name}` : `Agent "${killId}" not found.`);
      }
      break;
    }

    case "message": {
      const targetId = rest[1];
      const msg = rest.slice(2).join(" ");
      if (!targetId || !msg) {
        console.error("Usage: 8gent agent message <agent-id> <message>");
        process.exit(1);
      }
      bus.routeMessage(targetId, {
        id: `cli-${Date.now()}`,
        role: "user",
        content: msg,
        agentId: "cli",
        timestamp: new Date(),
      });
      if (isJson) {
        jsonOut({ success: true, agentId: targetId, message: msg });
      } else {
        console.log(`Message sent to ${targetId}`);
      }
      break;
    }

    case "auto": {
      const setting = rest[1];
      if (setting === "on") bus.setAutoSpawn(true);
      else if (setting === "off") bus.setAutoSpawn(false);
      else bus.setAutoSpawn(!bus.isAutoSpawnEnabled());

      if (isJson) {
        jsonOut({ autoSpawn: bus.isAutoSpawnEnabled() });
      } else {
        console.log(`Auto-spawn: ${bus.isAutoSpawnEnabled() ? "enabled" : "disabled"}`);
      }
      break;
    }

    case "status": {
      const agents = bus.getAgents();
      const pending = bus.getPendingSpawns();
      if (isJson) {
        jsonOut({
          agentCount: agents.length,
          pendingSpawns: pending.length,
          autoSpawn: bus.isAutoSpawnEnabled(),
          agents: agents.map(a => ({ id: a.id, persona: a.persona.id, status: a.status, task: a.task })),
        });
      } else {
        console.log(`Agents: ${agents.length} active`);
        console.log(`Pending spawns: ${pending.length}`);
        console.log(`Auto-spawn: ${bus.isAutoSpawnEnabled() ? "on" : "off"}`);
      }
      break;
    }

    default:
      console.error(`Unknown agent subcommand: ${sub}`);
      console.log("Available: list, spawn, kill, message, auto, status");
      process.exit(1);
  }
}

// ── Session Command ───────────────────────────────────────────────

async function sessionCommand(args: string[]) {
  const { flags, rest } = parseFlags(args);
  const isJson = !!flags.json;
  const sub = rest[0] || "list";

  switch (sub) {
    case "list": {
      const limit = parseInt((flags.limit as string) || "10");
      const { SessionSyncManager } = await import("../packages/eight/session-sync");
      const sync = new SessionSyncManager(true);

      const convos = await sync.getRecentConversations(limit);
      if (isJson) {
        jsonOut({ count: convos.length, sessions: convos });
      } else {
        if (convos.length === 0) {
          console.log("No sessions found. Requires authentication.");
        } else {
          for (const c of convos as any[]) {
            const ago = Math.floor((Date.now() - c.lastActiveAt) / 60000);
            const timeStr = ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
            console.log(`${c.sessionId}  ${c.title?.slice(0, 50) || "Untitled"}  ${c.model}  ${c.messageCount} msgs  ${timeStr}`);
          }
        }
      }
      break;
    }

    case "resume": {
      const sessionId = rest[1];
      if (!sessionId) {
        console.error("Usage: 8gent session resume <session-id>");
        process.exit(1);
      }
      // Resume launches TUI with session context
      const { spawn } = await import("child_process");
      const tuiPath = path.join(__dirname, "../apps/tui/src/index.tsx");
      const proc = spawn("bun", ["run", tuiPath, "--resume", sessionId], {
        stdio: "inherit",
        cwd: path.join(__dirname, ".."),
      });
      proc.on("exit", (code) => process.exit(code || 0));
      break;
    }

    case "compact":
    case "checkpoint": {
      if (isJson) {
        jsonOut({ success: true, message: `${sub} is a TUI operation — use /compact or /checkpoint in the TUI` });
      } else {
        console.log(`${sub} is a TUI operation. Launch the TUI and use /${sub}.`);
      }
      break;
    }

    default:
      console.error(`Unknown session subcommand: ${sub}`);
      console.log("Available: list, resume, compact, checkpoint");
      process.exit(1);
  }
}

// ── Preferences Command ───────────────────────────────────────────

async function preferencesCommand(args: string[]) {
  const { flags, rest } = parseFlags(args);
  const isJson = !!flags.json;
  const sub = rest[0] || "get";
  const cwd = (flags.cwd as string) || process.cwd();

  const { OnboardingManager } = await import("../packages/self-autonomy/onboarding");
  const mgr = new OnboardingManager(cwd);

  switch (sub) {
    case "get": {
      const user = mgr.getUser();
      if (isJson) {
        jsonOut(user);
      } else {
        console.log(`Name: ${user.identity.name || "Not set"}`);
        console.log(`Role: ${user.identity.role || "Not set"}`);
        console.log(`Style: ${user.identity.communicationStyle || "Not set"}`);
        console.log(`Language: ${user.identity.language}`);
        console.log(`Model: ${user.preferences.model.default || "auto"}`);
        console.log(`Provider: ${user.preferences.model.provider || "ollama"}`);
        console.log(`Voice: ${user.preferences.voice.enabled ? "on" : "off"}`);
        console.log(`Autonomy: ${user.preferences.autonomy.askThreshold}`);
        console.log(`Understanding: ${Math.round(user.understanding.confidenceScore * 100)}%`);
        console.log(`Onboarded: ${user.onboardingComplete ? "yes" : "no"}`);
      }
      break;
    }

    case "set": {
      const key = rest[1];
      const value = rest.slice(2).join(" ");
      if (!key || !value) {
        console.error("Usage: 8gent preferences set <key> <value>");
        console.log("\nKeys: name, role, style, language, model, provider, voice, autonomy, branch-prefix");
        process.exit(1);
      }

      const user = mgr.getUser();
      switch (key) {
        case "name": user.identity.name = value; break;
        case "role": user.identity.role = value; break;
        case "style": user.identity.communicationStyle = value as any; break;
        case "language": user.identity.language = value; break;
        case "model": user.preferences.model.default = value; break;
        case "provider": user.preferences.model.provider = value as any; break;
        case "voice": user.preferences.voice.enabled = value === "on" || value === "true"; break;
        case "autonomy": user.preferences.autonomy.askThreshold = value as any; break;
        case "branch-prefix": user.preferences.git.branchPrefix = value; break;
        default:
          console.error(`Unknown preference key: ${key}`);
          process.exit(1);
      }

      // Save via updatePreferences
      mgr.updatePreferences(user.preferences);
      if (isJson) {
        jsonOut({ success: true, key, value });
      } else {
        console.log(`Set ${key} = ${value}`);
      }
      break;
    }

    case "sync": {
      const { PreferencesSyncManager } = await import("../packages/self-autonomy/preferences-sync");
      const sync = new PreferencesSyncManager(cwd);
      try {
        const { initAuth } = await import("../packages/auth");
        const authState = await initAuth();
        if (authState.state !== "authenticated") {
          console.error("Not authenticated. Run `8gent auth login` first.");
          process.exit(2);
        }
        await sync.syncOnLogin(authState.user.clerkId);
        if (isJson) {
          jsonOut({ success: true, message: "Preferences synced from cloud" });
        } else {
          console.log("Preferences synced from cloud.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJson) jsonOut({ success: false, error: msg });
        else console.error(`Sync failed: ${msg}`);
        process.exit(1);
      }
      break;
    }

    case "reset": {
      mgr.reset();
      if (isJson) {
        jsonOut({ success: true, message: "Preferences reset to defaults" });
      } else {
        console.log("Preferences reset to defaults.");
      }
      break;
    }

    default:
      console.error(`Unknown preferences subcommand: ${sub}`);
      console.log("Available: get, set, sync, reset");
      process.exit(1);
  }
}

// ── Memory Command ────────────────────────────────────────────────

async function memoryCommand(args: string[]) {
  const { flags, rest } = parseFlags(args);
  const isJson = !!flags.json;
  const sub = rest[0] || "stats";
  const cwd = (flags.cwd as string) || process.cwd();

  const { getMemoryManager } = await import("../packages/memory");
  const memory = getMemoryManager(cwd);

  switch (sub) {
    case "recall": {
      const query = rest.slice(1).join(" ");
      if (!query) {
        console.error("Usage: 8gent memory recall <query>");
        process.exit(1);
      }
      const results = await memory.recall(query, 10);
      if (isJson) {
        jsonOut({ query, count: results.length, results });
      } else {
        if (results.length === 0) {
          console.log("No memories found.");
        } else {
          for (const r of results as any[]) {
            const entry = r.entry || r.memory;
            const fact = entry?.fact || entry?.value || entry?.content || JSON.stringify(entry);
            console.log(`[${(r.score || 0).toFixed(2)}] ${fact.slice(0, 120)}`);
          }
        }
      }
      break;
    }

    case "remember": {
      const fact = rest.slice(1).join(" ");
      if (!fact) {
        console.error("Usage: 8gent memory remember <fact>");
        process.exit(1);
      }
      const id = await memory.remember(fact, "project", { source: "cli" });
      if (isJson) {
        jsonOut({ success: true, id, fact });
      } else {
        console.log(`Remembered: ${fact.slice(0, 80)}${fact.length > 80 ? "..." : ""}`);
        console.log(`ID: ${id}`);
      }
      break;
    }

    case "forget": {
      const id = rest[1];
      if (!id) {
        console.error("Usage: 8gent memory forget <id>");
        process.exit(1);
      }
      const success = await memory.forget(id);
      if (isJson) {
        jsonOut({ success, id });
      } else {
        console.log(success ? `Forgot: ${id}` : `Memory "${id}" not found.`);
      }
      break;
    }

    case "stats": {
      try {
        const ctx = await memory.getContext({ maxTokens: 1 });
        if (isJson) {
          jsonOut({ stats: ctx.stats });
        } else {
          console.log(`Total memories: ${ctx.stats.totalMemories}`);
          console.log(`By type: ${JSON.stringify(ctx.stats.byType)}`);
        }
      } catch {
        if (isJson) {
          jsonOut({ stats: { totalMemories: 0, byType: {} } });
        } else {
          console.log("Memory system not initialized or empty.");
        }
      }
      break;
    }

    default:
      console.error(`Unknown memory subcommand: ${sub}`);
      console.log("Available: recall, remember, forget, stats");
      process.exit(1);
  }
}

// ── Onboard Command (non-interactive auto-detect) ─────────────────

async function onboardCommand(args: string[]) {
  const { flags } = parseFlags(args);
  const isJson = !!flags.json;
  const cwd = (flags.cwd as string) || process.cwd();

  const { OnboardingManager } = await import("../packages/self-autonomy/onboarding");

  console.error("Auto-detecting environment...");
  const detected = await OnboardingManager.autoDetect();

  const mgr = new OnboardingManager(cwd);
  mgr.applyAutoDetected(detected);

  // If --yes, auto-complete onboarding with defaults
  if (flags.yes) {
    const user = mgr.getUser();
    if (!user.identity.communicationStyle) {
      user.identity.communicationStyle = "concise";
    }
    user.onboardingComplete = true;
    mgr.updatePreferences(user.preferences);
  }

  if (isJson) {
    jsonOut({
      detected,
      user: mgr.getUser(),
      onboardingComplete: mgr.getUser().onboardingComplete,
    });
  } else {
    console.log(`Name: ${detected.name || "not detected"}`);
    console.log(`Email: ${detected.email || "not detected"}`);
    console.log(`GitHub: ${detected.githubUsername || "not detected"}`);
    console.log(`Provider: ${detected.preferredProvider || "not detected"}`);
    console.log(`Ollama models: ${detected.ollamaModels.length > 0 ? detected.ollamaModels.join(", ") : "none"}`);
    console.log(`\nApplied to .8gent/user.json`);
    if (!mgr.getUser().onboardingComplete) {
      console.log("Run with --yes to auto-complete onboarding with defaults.");
    }
  }
}

// ── Status Command ────────────────────────────────────────────────

async function statusCommand(args: string[]) {
  const { flags } = parseFlags(args);
  const isJson = !!flags.json;
  const cwd = (flags.cwd as string) || process.cwd();

  const status: Record<string, unknown> = {
    version: VERSION,
    cwd,
    platform: process.platform,
    runtime: "bun",
  };

  // Check .8gent config
  try {
    const configPath = path.join(cwd, ".8gent", "config.json");
    if (fs.existsSync(configPath)) {
      status.config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {}

  // Check user config
  try {
    const { OnboardingManager } = await import("../packages/self-autonomy/onboarding");
    const mgr = new OnboardingManager(cwd);
    const user = mgr.getUser();
    status.user = {
      name: user.identity.name,
      onboarded: user.onboardingComplete,
      model: user.preferences.model.default,
      provider: user.preferences.model.provider,
      style: user.identity.communicationStyle,
    };
  } catch {}

  // Check auth
  try {
    const { initAuth } = await import("../packages/auth");
    const authState = await initAuth();
    status.auth = authState.state === "authenticated"
      ? { state: "authenticated", user: authState.user.githubUsername, plan: authState.user.plan }
      : { state: "anonymous" };
  } catch {
    status.auth = { state: "unknown" };
  }

  // Check Ollama
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const { stdout } = await execAsync("ollama list 2>/dev/null");
    const models = stdout.split("\n").slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
    status.ollama = { available: true, models, count: models.length };
  } catch {
    status.ollama = { available: false, models: [], count: 0 };
  }

  // Check orchestration
  try {
    const { getOrchestratorBus } = await import("../packages/orchestration/orchestrator-bus");
    const bus = getOrchestratorBus();
    status.agents = { count: bus.getAgentCount(), autoSpawn: bus.isAutoSpawnEnabled() };
  } catch {
    status.agents = { count: 0, autoSpawn: false };
  }

  // Check kernel
  try {
    const { KernelManager } = await import("../packages/kernel/manager");
    const km = KernelManager.fromProjectConfig(cwd);
    status.kernel = { enabled: km.isEnabled, pairCount: km.getTrainingPairCount() };
  } catch {
    status.kernel = { enabled: false };
  }

  // Git status
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd });
    const { stdout: hash } = await execAsync("git rev-parse --short HEAD", { cwd });
    status.git = { branch: branch.trim(), commit: hash.trim() };
  } catch {
    status.git = { branch: null, commit: null };
  }

  if (isJson) {
    jsonOut(status);
  } else {
    console.log(`8gent Code v${VERSION}`);
    console.log(`─────────────────────────`);
    for (const [key, val] of Object.entries(status)) {
      if (key === "version") continue;
      if (typeof val === "object" && val !== null) {
        console.log(`${key}:`);
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          const display = Array.isArray(v) ? `[${(v as any[]).length}]` : String(v);
          console.log(`  ${k}: ${display}`);
        }
      } else {
        console.log(`${key}: ${val}`);
      }
    }
  }
}

function getSymbolIcon(kind: string): string {
  const icons: Record<string, string> = {
    function: "ƒ",
    method: "μ",
    class: "◆",
    interface: "◇",
    type: "τ",
    constant: "π",
    variable: "ν",
    module: "□",
  };
  return icons[kind] || "·";
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
