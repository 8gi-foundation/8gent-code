#!/usr/bin/env bun
/**
 * 8gent Code - Main CLI Entry Point
 *
 * The terminal-first agentic coding experience.
 * "Never hit usage caps again"
 */

import * as path from "path";
import * as fs from "fs";

const VERSION = "0.4.4";
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
  8 <command> [options]
  8gent <command> [options]

COMMANDS:
  init          Initialize 8gent in current directory
  outline       Get symbol outline of a file
  symbol        Get source code for a specific symbol
  search        Search for symbols across files
  benchmark     Run efficiency benchmarks
  demo          Show token savings demo
  tui           Launch interactive TUI
  infinite      Run task in autonomous infinite mode

OPTIONS:
  -h, --help     Show this help message
  -v, --version  Show version
  --json         Output as JSON
  --stats        Show efficiency statistics
  --infinite     Enable infinite mode (autonomous until done)

EXAMPLES:
  8gent outline src/index.ts
  8gent symbol src/utils.ts::parseDate
  8gent search "handleError" --kinds function,method
  8gent benchmark --quick src/
  8gent infinite "Build a Next.js landing page with dark theme"

INFINITE MODE:
  Autonomous execution until success criteria met.
  No questions, no crashes stop it, self-healing errors.
  Like --dangerously-skip-permissions but smarter.

PHILOSOPHY:
  plan → retrieve → compose → verify
  (not: search → read → guess → patch)

Learn more: https://github.com/8gent/8gent-code
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(BANNER);
    console.log(HELP);
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

    case "infinite":
      await infiniteCommand(restArgs);
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

async function tuiCommand(args: string[]) {
  console.log(BANNER);
  console.log("Launching TUI...\n");

  // Dynamic import to launch TUI
  const { spawn } = await import("child_process");
  const tuiPath = path.join(__dirname, "../apps/tui/src/index.tsx");

  const proc = spawn("bun", ["run", tuiPath, ...args], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });

  proc.on("exit", (code) => process.exit(code || 0));
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
