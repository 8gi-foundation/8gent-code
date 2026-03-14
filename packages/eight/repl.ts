/**
 * 8gent Code - CLI REPL
 *
 * Interactive command-line interface with 40+ slash commands.
 * This is the user-facing entry point for the CLI mode.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import type { AgentConfig } from "./types";
import { Agent } from "./agent";
import {
  getPermissionManager,
} from "../permissions";
import {
  getHookManager,
} from "../hooks";
import {
  getSkillManager,
  parseSkillCommand,
} from "../skills";
import {
  getAgentPool,
  parseSpawnCommand,
  formatAgentStatus,
} from "../orchestration";
import {
  getTaskManager,
  parseTaskCommand,
  formatTask,
} from "../tasks";
import { getMCPClient } from "../mcp";
import {
  getBackgroundTaskManager,
  formatTaskStatus,
  formatTaskOutput,
} from "../tools/background";
import { readRuns, type RunLogEntry } from "../reporting/runlog";

export async function startREPL(config?: Partial<AgentConfig>) {
  // Load config from file
  const configPath = path.join(os.homedir(), ".8gent", "config.json");
  let savedConfig: Partial<AgentConfig> = {};

  if (fs.existsSync(configPath)) {
    savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  const finalConfig: AgentConfig = {
    model: config?.model || savedConfig.model || "glm-4.7-flash:latest",
    runtime: "ollama",
    workingDirectory: config?.workingDirectory || process.cwd(),
    ...config,
  };

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   █████╗  ██████╗ ███████╗███╗   ██╗████████╗             ║
║  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝             ║
║  ╚█████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║                ║
║  ██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║                ║
║  ╚█████╔╝╚██████╔╝███████╗██║ ╚████║   ██║                ║
║   ╚════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   CODE         ║
╚═══════════════════════════════════════════════════════════╝

Model: ${finalConfig.model}
Working directory: ${finalConfig.workingDirectory}

Type your request, or:
  /help     - Show commands
  /clear    - Clear history
  /quit     - Exit
`);

  const agent = new Agent(finalConfig);

  // Check if Ollama is running
  if (!(await agent.isReady())) {
    console.log("⚠️  Ollama is not running. Start it with: ollama serve");
    console.log("   Then run: npx 8gent-code");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("\n\x1b[36m❯\x1b[0m ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
        console.log("Goodbye!");
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        agent.clearHistory();
        console.log("History cleared.");
        prompt();
        return;
      }

      if (trimmed === "/help") {
        printHelp();
        prompt();
        return;
      }

      // Model commands
      if (await handleModelCommands(trimmed, agent)) { prompt(); return; }

      // Provider commands
      if (await handleProviderCommands(trimmed)) { prompt(); return; }

      // Planner/board commands
      if (handlePlannerCommands(trimmed)) { prompt(); return; }

      // Plan/status commands
      if (await handlePlanCommands(trimmed, agent)) { prompt(); return; }

      // MCP commands
      if (handleMCPCommands(trimmed)) { prompt(); return; }

      // LSP commands
      if (handleLSPCommands(trimmed)) { prompt(); return; }

      // Report commands
      if (handleReportSlashCommands(trimmed, agent)) { prompt(); return; }

      // Voice commands
      if (await handleVoiceCommands(trimmed)) { prompt(); return; }

      // Language commands
      if (await handleLanguageCommands(trimmed)) { prompt(); return; }

      // Background task commands
      if (handleBackgroundCommands(trimmed)) { prompt(); return; }

      // Permission commands
      if (handlePermissionCommands(trimmed)) { prompt(); return; }

      // Hooks commands
      if (handleHooksCommands(trimmed)) { prompt(); return; }

      // Skills commands
      if (await handleSkillsCommands(trimmed)) { prompt(); return; }

      // Multi-agent commands
      if (await handleAgentCommands(trimmed)) { prompt(); return; }

      // Task commands
      if (handleTaskCommands(trimmed)) { prompt(); return; }

      // Skill invocation (/<skill-name>)
      if (await handleSkillInvocation(trimmed, agent)) { prompt(); return; }

      // Regular chat
      try {
        const response = await agent.chat(trimmed);
        console.log(`\n\x1b[32m${response}\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[31mError: ${err}\x1b[0m`);
      }

      prompt();
    });
  };

  prompt();
}

// ============================================
// Command Handlers
// ============================================

function printHelp(): void {
  console.log(`
\x1b[36m8gent Commands:\x1b[0m

\x1b[33mBasic:\x1b[0m
  /help       - Show this help
  /clear      - Clear conversation history
  /quit       - Exit 8gent

\x1b[33mModel:\x1b[0m
  /model              - Show current model and provider
  /model <name>       - Switch model (e.g., /model qwen3:14b)
  /models             - List available models

\x1b[33mProviders:\x1b[0m
  /providers          - List all providers and status
  /provider <name>    - Switch to provider (ollama, openrouter, groq, etc.)
  /provider key <key> - Set API key for current provider
  /provider models    - List models for current provider

\x1b[33mBMAD Planning:\x1b[0m
  /plan <task>        - Create a plan without executing
  /status             - Show current task status
  /board              - Show kanban board (backlog/ready/inProgress/done)
  /predict            - Show top proactive predictions with confidence
  /momentum           - Show steps completed, rate, streak

\x1b[33mPermissions:\x1b[0m
  /permissions        - Show permission config
  /allow <pattern>    - Allow commands matching pattern
  /deny <pattern>     - Deny commands matching pattern
  /auto-approve       - Toggle auto-approve mode

\x1b[33mHooks:\x1b[0m
  /hooks              - List all hooks
  /hooks enable <id>  - Enable a hook
  /hooks disable <id> - Disable a hook

\x1b[33mSkills:\x1b[0m
  /skills             - List available skills
  /<skill> [args]     - Invoke a skill (e.g., /commit "feat: add feature")

\x1b[33mMulti-Agent:\x1b[0m
  /spawn <task>       - Spawn background agent for task
  /agents             - List running agents
  /agent <id>         - Get status and evidence for specific agent
  /join <id>          - Wait for agent to complete
  /kill <id>          - Terminate an agent
  /evidence           - Show all collected evidence for current task

\x1b[33mTasks:\x1b[0m
  /task "desc"        - Create a new task
  /tasks              - List all tasks
  /task:done <id>     - Mark task complete
  /task:start <id>    - Start working on task

\x1b[33mMCP (Model Context Protocol):\x1b[0m
  /mcp                - Show MCP server status
  /mcp-tools          - List available MCP tools

\x1b[33mBackground Tasks:\x1b[0m
  /bg                 - List background tasks
  /bg <id>            - Show task details

\x1b[33mLSP (Language Server Protocol):\x1b[0m
  /lsp                - Show LSP status and supported languages

\x1b[33mCompletion Reports:\x1b[0m
  /reports            - List recent completion reports
  /reports --stats    - Show report statistics
  /report <id>        - View a specific report
  /reporting          - Toggle completion reports on/off

\x1b[33mVoice:\x1b[0m
  /voice              - Show all voice settings
  /voice on/off       - Enable/disable voice TTS
  /voice test         - Test voice output
  /voice <name>       - Set voice (Daniel, Alex, Tom, Oliver, etc.)
  /voice rate <wpm>   - Set speech rate (100-300)
  /voice voices       - List available voices

\x1b[33mLanguage:\x1b[0m
  /language           - Show current language
  /language <code>    - Set language (en, es, fr, de, ja, zh, pt-br, etc.)
  /languages          - List all supported languages

\x1b[33mTips:\x1b[0m
  - Ask to explore code: "What functions are in src/index.ts?"
  - Ask to build something: "Build a React component for..."
  - Ask to fix code: "Fix the bug in the login function"
  - Web search: "Search for React hooks best practices"
`);
}

function handlePlannerCommands(trimmed: string): boolean {
  if (trimmed === "/board") {
    const { getProactivePlanner } = require("../planning/proactive-planner");
    const planner = getProactivePlanner();
    const board = planner.getBoard();

    console.log(`\n\x1b[36mKanban Board:\x1b[0m\n`);

    const columns = [
      { name: "Backlog", items: board.backlog, color: "\x1b[90m" },
      { name: "Ready", items: board.ready, color: "\x1b[33m" },
      { name: "In Progress", items: board.inProgress, color: "\x1b[36m" },
      { name: "Done", items: board.done.slice(-5), color: "\x1b[32m" },
    ];

    for (const col of columns) {
      console.log(`  ${col.color}${col.name} (${col.items.length}):\x1b[0m`);
      if (col.items.length === 0) {
        console.log(`    (empty)`);
      } else {
        for (const item of col.items.slice(0, 5)) {
          const conf = `${Math.round(item.confidence * 100)}%`;
          console.log(`    [${item.category}] ${item.description} (${conf})`);
        }
      }
    }
    return true;
  }

  if (trimmed === "/predict") {
    const { getProactivePlanner } = require("../planning/proactive-planner");
    const planner = getProactivePlanner();
    const ready = planner.getReadySteps();
    const next = planner.getNextRecommendedStep();

    console.log(`\n\x1b[36mPredictions:\x1b[0m\n`);

    if (ready.length === 0 && !next) {
      console.log("  No predictions yet. Start working to generate predictions.");
    } else {
      if (next) {
        console.log(`  \x1b[33m★ Next recommended:\x1b[0m ${next.description}`);
        console.log(`    Tool: ${next.tool} | Confidence: ${Math.round(next.confidence * 100)}% | Priority: ${next.priority}\n`);
      }
      if (ready.length > 0) {
        console.log(`  \x1b[36mReady steps:\x1b[0m`);
        for (const step of ready) {
          const score = (step.priority * step.confidence).toFixed(1);
          console.log(`    [${step.category}] ${step.description} (score: ${score})`);
        }
      }
    }
    return true;
  }

  if (trimmed === "/momentum") {
    const { getProactivePlanner } = require("../planning/proactive-planner");
    const planner = getProactivePlanner();
    const m = planner.getMomentum();

    console.log(`\n\x1b[36mMomentum:\x1b[0m`);
    console.log(`  Steps completed: \x1b[32m${m.stepsCompleted}\x1b[0m`);
    console.log(`  Rate: \x1b[33m${m.stepsPerMinute.toFixed(1)} steps/min\x1b[0m`);
    console.log(`  Streak: \x1b[36m${m.streak}\x1b[0m consecutive`);
    return true;
  }

  return false;
}

async function handleModelCommands(trimmed: string, agent: Agent): Promise<boolean> {
  if (trimmed === "/model") {
    const { getProviderManager } = await import("../providers/index.js");
    const pm = getProviderManager();
    const p = pm.getActiveProvider();
    console.log(`Provider: \x1b[33m${p.displayName}\x1b[0m`);
    console.log(`Model:    \x1b[36m${pm.getActiveModel()}\x1b[0m`);
    return true;
  }

  if (trimmed.startsWith("/model ")) {
    const newModel = trimmed.slice(7).trim();
    const { getProviderManager } = await import("../providers/index.js");
    const pm = getProviderManager();
    pm.setActiveModel(newModel);
    agent.setModel(newModel);
    console.log(`Switched to model: \x1b[36m${newModel}\x1b[0m`);
    return true;
  }

  if (trimmed === "/models") {
    const { getProviderManager } = await import("../providers/index.js");
    const pm = getProviderManager();
    const provider = pm.getActiveProvider();

    console.log(`\x1b[36mModels for ${provider.displayName}:\x1b[0m`);

    if (provider.name === "ollama") {
      try {
        const response = await fetch("http://localhost:11434/api/tags");
        const data = await response.json();
        for (const model of data.models || []) {
          const current = model.name === pm.getActiveModel() ? " \x1b[32m← current\x1b[0m" : "";
          console.log(`  - ${model.name} (${(model.size / 1e9).toFixed(1)}GB)${current}`);
        }
      } catch {
        console.log("  Could not fetch Ollama models. Is Ollama running?");
      }
    } else {
      for (const model of provider.models) {
        const current = model === pm.getActiveModel() ? " \x1b[32m← current\x1b[0m" : "";
        console.log(`  - ${model}${current}`);
      }
    }
    return true;
  }

  return false;
}

async function handleProviderCommands(trimmed: string): Promise<boolean> {
  if (trimmed === "/providers") {
    const { getProviderManager, PROVIDER_NAMES } = await import("../providers/index.js");
    const pm = getProviderManager();
    const active = pm.getActiveProvider();

    console.log(`\n\x1b[36mLLM Providers:\x1b[0m\n`);
    for (const name of PROVIDER_NAMES) {
      const p = pm.getProvider(name);
      const hasKey = pm.getApiKey(name) ? "\x1b[32m✓ key\x1b[0m" : "\x1b[33m○ no key\x1b[0m";
      const isActive = p.name === active.name ? " \x1b[36m← active\x1b[0m" : "";
      const keyInfo = p.name === "ollama" ? "\x1b[32m✓ local\x1b[0m" : hasKey;
      console.log(`  ${p.displayName.padEnd(20)} ${keyInfo}${isActive}`);
    }
    console.log(`\n  Use \x1b[36m/provider <name>\x1b[0m to switch`);
    console.log(`  Use \x1b[36m/provider key <api-key>\x1b[0m to set key for current provider\n`);
    return true;
  }

  if (trimmed === "/provider") {
    const { getProviderManager } = await import("../providers/index.js");
    const pm = getProviderManager();
    const p = pm.getActiveProvider();
    const hasKey = pm.getApiKey(p.name);
    console.log(`\n\x1b[36mCurrent Provider:\x1b[0m ${p.displayName}`);
    console.log(`  Model: ${pm.getActiveModel()}`);
    console.log(`  API Key: ${p.name === "ollama" ? "not needed (local)" : hasKey ? "✓ set" : "✗ not set"}`);
    console.log(`  Tools: ${p.supportsTools ? "✓" : "✗"}  Streaming: ${p.supportsStreaming ? "✓" : "✗"}  Vision: ${p.supportsVision ? "✓" : "✗"}`);
    return true;
  }

  if (trimmed === "/provider models") {
    const { getProviderManager } = await import("../providers/index.js");
    const pm = getProviderManager();
    const p = pm.getActiveProvider();
    console.log(`\x1b[36mModels for ${p.displayName}:\x1b[0m`);
    for (const model of p.models) {
      const current = model === pm.getActiveModel() ? " \x1b[32m← current\x1b[0m" : "";
      console.log(`  - ${model}${current}`);
    }
    return true;
  }

  if (trimmed.startsWith("/provider key ")) {
    const apiKey = trimmed.slice(14).trim();
    if (!apiKey) {
      console.log("\x1b[31mUsage: /provider key <your-api-key>\x1b[0m");
    } else {
      const { getProviderManager } = await import("../providers/index.js");
      const pm = getProviderManager();
      const p = pm.getActiveProvider();
      if (p.name === "ollama") {
        console.log("\x1b[33mOllama doesn't need an API key (it's local)\x1b[0m");
      } else {
        pm.setApiKey(p.name, apiKey);
        console.log(`\x1b[32mAPI key saved for ${p.displayName}\x1b[0m`);
        console.log(`  Stored in ~/.8gent/providers.json`);
      }
    }
    return true;
  }

  if (trimmed.startsWith("/provider ") && !trimmed.startsWith("/provider key") && !trimmed.startsWith("/provider models")) {
    const providerName = trimmed.slice(10).trim().toLowerCase();
    const { getProviderManager, PROVIDER_NAMES } = await import("../providers/index.js");

    if (!PROVIDER_NAMES.includes(providerName as any)) {
      console.log(`\x1b[31mUnknown provider: ${providerName}\x1b[0m`);
      console.log(`Available: ${PROVIDER_NAMES.join(", ")}`);
    } else {
      const pm = getProviderManager();
      pm.setActiveProvider(providerName as any);
      const p = pm.getActiveProvider();
      console.log(`\x1b[32mSwitched to ${p.displayName}\x1b[0m`);
      console.log(`  Model: ${pm.getActiveModel()}`);

      if (p.name !== "ollama" && !pm.getApiKey(p.name)) {
        console.log(`\n  \x1b[33m⚠ No API key set.\x1b[0m`);
        console.log(`  Set with: /provider key <your-${p.name}-api-key>`);
        console.log(`  Or set env: export ${p.apiKeyEnv}=<key>`);
      }
    }
    return true;
  }

  return false;
}

async function handlePlanCommands(trimmed: string, agent: Agent): Promise<boolean> {
  if (trimmed.startsWith("/plan ")) {
    const task = trimmed.slice(6).trim();
    console.log(`\n\x1b[33mCreating plan for:\x1b[0m ${task}\n`);
    const planPrompt = `Create a PLAN ONLY (do not execute) for: ${task}\nOutput format: PLAN: 1) ... 2) ... 3) ...`;
    try {
      const response = await agent.chat(planPrompt);
      console.log(`\n\x1b[32m${response}\x1b[0m`);
    } catch (err) {
      console.error(`\x1b[31mError: ${err}\x1b[0m`);
    }
    return true;
  }

  if (trimmed === "/status") {
    console.log(`\n\x1b[36m8gent Status:\x1b[0m`);
    console.log(`  Model: ${agent.getModel()}`);
    console.log(`  Working Dir: ${process.cwd()}`);
    console.log(`  History: ${agent.getHistoryLength()} messages`);
    return true;
  }

  return false;
}

function handleMCPCommands(trimmed: string): boolean {
  if (trimmed === "/mcp") {
    const mcpClient = getMCPClient();
    const servers = mcpClient.getRunningServers();
    if (servers.length === 0) {
      console.log("\x1b[33mNo MCP servers running.\x1b[0m Configure in ~/.8gent/mcp.json");
    } else {
      console.log("\x1b[36mMCP Servers:\x1b[0m");
      for (const server of servers) {
        const tools = mcpClient.getServerTools(server);
        console.log(`  - ${server}: ${tools.length} tools`);
      }
    }
    return true;
  }

  if (trimmed === "/mcp-tools") {
    const mcpClient = getMCPClient();
    const tools = mcpClient.listTools();
    if (tools.length === 0) {
      console.log("\x1b[33mNo MCP tools available.\x1b[0m");
    } else {
      console.log("\x1b[36mMCP Tools:\x1b[0m");
      for (const { server, tool } of tools) {
        console.log(`  [\x1b[33m${server}\x1b[0m] ${tool.name}: ${tool.description || "No description"}`);
      }
    }
    return true;
  }

  return false;
}

function handleLSPCommands(trimmed: string): boolean {
  if (trimmed === "/lsp") {
    console.log(`
\x1b[36mLSP Status:\x1b[0m
  Supported languages: typescript, python, rust
  Required servers:
    - typescript: typescript-language-server (npm install -g typescript-language-server typescript)
    - python: pyright (pip install pyright)
    - rust: rust-analyzer (rustup component add rust-analyzer)

  LSP Tools:
    - lsp_goto_definition: Jump to symbol definition
    - lsp_find_references: Find all usages
    - lsp_hover: Get type info and docs
    - lsp_document_symbols: Get all symbols in file
`);
    return true;
  }

  return false;
}

function handleReportSlashCommands(trimmed: string, agent: Agent): boolean {
  if (trimmed === "/runs" || trimmed === "/reports") {
    const runs = readRuns(15);
    if (runs.length === 0) {
      console.log("\x1b[90mNo runs yet.\x1b[0m");
      return true;
    }
    for (const r of runs) {
      const st = r.status === "ok" ? "\x1b[32m ok\x1b[0m" : "\x1b[31mfail\x1b[0m";
      const cost = r.cost != null ? `$${r.cost.toFixed(4)}` : "—";
      const files = [...r.created, ...r.modified].length;
      console.log(
        `${st}  ${r.dur}s  ${r.tokens.toLocaleString()}tok  ${cost}  ${files}f  ${r.model}  ${r.prompt.slice(0, 50)}`
      );
    }
    return true;
  }

  if (trimmed === "/reporting") {
    const current = agent.isReportingEnabled();
    agent.setReportingEnabled(!current);
    console.log(`Run logging: ${!current ? "\x1b[32mON\x1b[0m" : "\x1b[33mOFF\x1b[0m"}`);
    return true;
  }

  return false;
}

async function handleVoiceCommands(trimmed: string): Promise<boolean> {
  if (trimmed === "/voice") {
    const { getVoiceConfig } = await import("../hooks/voice.js");
    const config = getVoiceConfig();
    console.log(`
\x1b[36mVoice Settings:\x1b[0m
  Enabled:   ${config.enabled ? "\x1b[32mYes\x1b[0m" : "\x1b[33mNo\x1b[0m"}
  Voice:     \x1b[36m${config.voice}\x1b[0m
  Rate:      ${config.rate} wpm
  Max Chars: ${config.maxLength}
  Fallback:  "${config.fallbackMessage.slice(0, 50)}${config.fallbackMessage.length > 50 ? '...' : ''}"

\x1b[33mCommands:\x1b[0m
  /voice on              Enable voice
  /voice off             Disable voice
  /voice test            Test voice output
  /voice <name>          Set voice (Ava, Samantha, Alex, Daniel, Karen)
  /voice rate <wpm>      Set speech rate (100-300, default 200)
  /voice maxlength <n>   Set max chars to speak (default 350)
  /voice fallback <msg>  Set fallback message
  /voice voices          List available macOS voices
`);
    return true;
  }

  if (trimmed === "/voice on") {
    const { configureVoice } = await import("../hooks/voice.js");
    configureVoice({ enabled: true });
    console.log("\x1b[32mVoice enabled.\x1b[0m The Infinite Gentleman will speak.");
    return true;
  }

  if (trimmed === "/voice off") {
    const { configureVoice } = await import("../hooks/voice.js");
    configureVoice({ enabled: false });
    console.log("\x1b[33mVoice disabled.\x1b[0m");
    return true;
  }

  if (trimmed === "/voice test") {
    const { testVoice } = await import("../hooks/voice.js");
    console.log("Testing voice...");
    try {
      await testVoice();
      console.log("\x1b[32mVoice test complete.\x1b[0m");
    } catch (err) {
      console.log(`\x1b[31mVoice test failed: ${err}\x1b[0m`);
    }
    return true;
  }

  if (trimmed === "/voice voices") {
    console.log("\x1b[36mListing available voices...\x1b[0m");
    try {
      const { execSync } = await import("child_process");
      const voices = execSync("say -v '?'", { encoding: "utf-8" });
      const lines = voices.split("\n").filter(l => l.includes("en_")).slice(0, 20);
      console.log("\x1b[33mEnglish voices:\x1b[0m");
      for (const line of lines) {
        const match = line.match(/^(\S+)\s+(\S+)/);
        if (match) {
          console.log(`  ${match[1]} (${match[2]})`);
        }
      }
      console.log("\n  Run \x1b[36msay -v '?'\x1b[0m for full list");
    } catch {
      console.log("Could not list voices. macOS only.");
    }
    return true;
  }

  if (trimmed.startsWith("/voice rate ")) {
    const rateStr = trimmed.slice(12).trim();
    const rate = parseInt(rateStr, 10);
    if (isNaN(rate) || rate < 50 || rate > 400) {
      console.log("\x1b[31mRate must be between 50-400 wpm\x1b[0m");
    } else {
      const { configureVoice } = await import("../hooks/voice.js");
      configureVoice({ rate });
      console.log(`Voice rate set to: \x1b[36m${rate} wpm\x1b[0m`);
    }
    return true;
  }

  if (trimmed.startsWith("/voice maxlength ")) {
    const lenStr = trimmed.slice(17).trim();
    const maxLength = parseInt(lenStr, 10);
    if (isNaN(maxLength) || maxLength < 50 || maxLength > 1000) {
      console.log("\x1b[31mMax length must be between 50-1000 chars\x1b[0m");
    } else {
      const { configureVoice } = await import("../hooks/voice.js");
      configureVoice({ maxLength });
      console.log(`Max length set to: \x1b[36m${maxLength} chars\x1b[0m`);
    }
    return true;
  }

  if (trimmed.startsWith("/voice fallback ")) {
    const fallbackMessage = trimmed.slice(16).trim();
    if (fallbackMessage.length < 5) {
      console.log("\x1b[31mFallback message too short\x1b[0m");
    } else {
      const { configureVoice } = await import("../hooks/voice.js");
      configureVoice({ fallbackMessage });
      console.log(`Fallback message set to: \x1b[36m"${fallbackMessage}"\x1b[0m`);
    }
    return true;
  }

  if (trimmed.startsWith("/voice ")) {
    const voiceName = trimmed.slice(7).trim();
    const reserved = ["on", "off", "test", "voices", "rate", "maxlength", "fallback"];
    if (voiceName && !reserved.some(r => voiceName.startsWith(r))) {
      const { configureVoice } = await import("../hooks/voice.js");
      configureVoice({ voice: voiceName });
      console.log(`Voice set to: \x1b[36m${voiceName}\x1b[0m`);
      return true;
    }
  }

  return false;
}

async function handleLanguageCommands(trimmed: string): Promise<boolean> {
  if (trimmed === "/language") {
    const { getLanguageManager } = await import("../i18n/index.js");
    const lm = getLanguageManager();
    const lang = lm.getActiveLanguage();
    console.log(`\n\x1b[36mCurrent Language:\x1b[0m ${lang.name} (${lang.nativeName})`);
    console.log(`  Code: ${lang.code}`);
    console.log(`\n  Use \x1b[36m/language <code>\x1b[0m to change`);
    console.log(`  Use \x1b[36m/languages\x1b[0m to see all options\n`);
    return true;
  }

  if (trimmed === "/languages") {
    const { getLanguageManager } = await import("../i18n/index.js");
    const lm = getLanguageManager();
    const current = lm.getLanguageCode();
    const languages = lm.listLanguages();

    console.log(`\n\x1b[36mSupported Languages:\x1b[0m\n`);
    for (const lang of languages) {
      const marker = lang.code === current ? " \x1b[32m← current\x1b[0m" : "";
      console.log(`  ${lang.code.padEnd(6)} ${lang.name.padEnd(25)} ${lang.nativeName}${marker}`);
    }
    console.log(`\n  Use \x1b[36m/language <code>\x1b[0m to switch\n`);
    return true;
  }

  if (trimmed.startsWith("/language ")) {
    const code = trimmed.slice(10).trim().toLowerCase();
    const { getLanguageManager } = await import("../i18n/index.js");
    const lm = getLanguageManager();

    if (lm.setLanguage(code)) {
      const lang = lm.getActiveLanguage();
      console.log(`\x1b[32mLanguage set to: ${lang.name} (${lang.nativeName})\x1b[0m`);
      console.log(`  8gent will now respond in ${lang.name}.`);
    } else {
      console.log(`\x1b[31mUnknown language code: ${code}\x1b[0m`);
      console.log(`  Use \x1b[36m/languages\x1b[0m to see available options.`);
    }
    return true;
  }

  return false;
}

function handleBackgroundCommands(trimmed: string): boolean {
  if (trimmed === "/bg") {
    const taskManager = getBackgroundTaskManager();
    const tasks = taskManager.listTasks({ limit: 10 });
    if (tasks.length === 0) {
      console.log("\x1b[33mNo background tasks.\x1b[0m");
    } else {
      console.log("\x1b[36mBackground Tasks:\x1b[0m");
      for (const task of tasks) {
        console.log(`  ${formatTaskStatus(task)}`);
      }
    }
    return true;
  }

  if (trimmed.startsWith("/bg ")) {
    const taskId = trimmed.slice(4).trim();
    const taskManager = getBackgroundTaskManager();
    const status = taskManager.getTaskStatus(taskId);
    const output = taskManager.getTaskOutput(taskId);
    if (!status || !output) {
      console.log(`\x1b[31mTask not found: ${taskId}\x1b[0m`);
    } else {
      console.log(formatTaskOutput(output, status));
    }
    return true;
  }

  return false;
}

function handlePermissionCommands(trimmed: string): boolean {
  if (trimmed === "/permissions") {
    const permManager = getPermissionManager();
    const config = permManager.getConfig();
    const log = permManager.getLog();
    console.log(`\n\x1b[36mPermission Config:\x1b[0m`);
    console.log(`  Auto-approve: ${config.autoApprove ? "\x1b[32mON\x1b[0m" : "\x1b[33mOFF\x1b[0m"}`);
    console.log(`  Allowed patterns: ${config.allowedPatterns.length}`);
    for (const p of config.allowedPatterns.slice(0, 5)) {
      console.log(`    - ${p}`);
    }
    if (config.allowedPatterns.length > 5) {
      console.log(`    ... and ${config.allowedPatterns.length - 5} more`);
    }
    console.log(`  Denied patterns: ${config.deniedPatterns.length}`);
    for (const p of config.deniedPatterns) {
      console.log(`    - ${p}`);
    }
    console.log(`\n\x1b[36mSession Stats:\x1b[0m`);
    console.log(`  Approved: ${log.approvedCount}`);
    console.log(`  Auto-approved: ${log.autoApprovedCount}`);
    console.log(`  Denied: ${log.deniedCount}`);
    return true;
  }

  if (trimmed.startsWith("/allow ")) {
    const pattern = trimmed.slice(7).trim();
    if (pattern) {
      const permManager = getPermissionManager();
      permManager.allowPattern(pattern);
      console.log(`\x1b[32mAllowed pattern:\x1b[0m ${pattern}`);
    } else {
      console.log("\x1b[31mUsage: /allow <pattern>\x1b[0m");
    }
    return true;
  }

  if (trimmed.startsWith("/deny ")) {
    const pattern = trimmed.slice(6).trim();
    if (pattern) {
      const permManager = getPermissionManager();
      permManager.denyPattern(pattern);
      console.log(`\x1b[31mDenied pattern:\x1b[0m ${pattern}`);
    } else {
      console.log("\x1b[31mUsage: /deny <pattern>\x1b[0m");
    }
    return true;
  }

  if (trimmed === "/auto-approve") {
    const permManager = getPermissionManager();
    const current = permManager.getConfig().autoApprove;
    permManager.setAutoApprove(!current);
    console.log(`Auto-approve: ${!current ? "\x1b[32mON\x1b[0m" : "\x1b[33mOFF\x1b[0m"}`);
    return true;
  }

  return false;
}

function handleHooksCommands(trimmed: string): boolean {
  if (trimmed === "/hooks") {
    const hooksManager = getHookManager();
    const hooks = hooksManager.getAllHooks();
    console.log(`\n\x1b[36mRegistered Hooks:\x1b[0m (${hooks.length} total)`);
    if (hooks.length === 0) {
      console.log("  No hooks registered. Add hooks to ~/.8gent/hooks.json");
    }
    for (const hook of hooks) {
      const status = hook.enabled ? "\x1b[32m[ON]\x1b[0m" : "\x1b[33m[OFF]\x1b[0m";
      console.log(`  ${status} ${hook.name} (${hook.type})`);
      console.log(`       ID: ${hook.id}`);
      if (hook.description) {
        console.log(`       ${hook.description}`);
      }
    }
    return true;
  }

  if (trimmed.startsWith("/hooks enable ")) {
    const hookId = trimmed.slice(14).trim();
    if (hookId) {
      const hooksManager = getHookManager();
      if (hooksManager.enableHook(hookId)) {
        console.log(`\x1b[32mEnabled hook:\x1b[0m ${hookId}`);
      } else {
        console.log(`\x1b[31mHook not found:\x1b[0m ${hookId}`);
      }
    } else {
      console.log("\x1b[31mUsage: /hooks enable <hook-id>\x1b[0m");
    }
    return true;
  }

  if (trimmed.startsWith("/hooks disable ")) {
    const hookId = trimmed.slice(15).trim();
    if (hookId) {
      const hooksManager = getHookManager();
      if (hooksManager.disableHook(hookId)) {
        console.log(`\x1b[33mDisabled hook:\x1b[0m ${hookId}`);
      } else {
        console.log(`\x1b[31mHook not found:\x1b[0m ${hookId}`);
      }
    } else {
      console.log("\x1b[31mUsage: /hooks disable <hook-id>\x1b[0m");
    }
    return true;
  }

  return false;
}

async function handleSkillsCommands(trimmed: string): Promise<boolean> {
  if (trimmed === "/skills") {
    try {
      const skillManager = getSkillManager();
      await skillManager.loadSkills();
      const skills = skillManager.getAllSkills();
      console.log(`\n\x1b[36mAvailable Skills:\x1b[0m (${skills.length})`);
      console.log(`Skills directory: ${skillManager.getSkillsDirectory()}\n`);
      for (const skill of skills) {
        console.log(`  \x1b[33m/${skill.name}\x1b[0m - ${skill.description}`);
        if (skill.tools.length > 0) {
          console.log(`    Tools: ${skill.tools.join(", ")}`);
        }
      }
      if (skills.length === 0) {
        console.log("  No skills found. Create .md files in ~/.8gent/skills/");
      }
    } catch (err) {
      console.error(`\x1b[31mError loading skills: ${err}\x1b[0m`);
    }
    return true;
  }

  return false;
}

async function handleAgentCommands(trimmed: string): Promise<boolean> {
  if (trimmed.startsWith("/spawn ")) {
    const parsed = parseSpawnCommand(trimmed);
    if (!parsed || !parsed.task) {
      console.log("\x1b[31mUsage: /spawn <task description> [--model <model>] [--dir <path>]\x1b[0m");
      return true;
    }

    try {
      const pool = getAgentPool();
      const spawnedAgent = await pool.spawnAgent(parsed.task, parsed.options);
      console.log(`\n\x1b[32mSpawned agent:\x1b[0m ${spawnedAgent.id}`);
      console.log(`  Task: ${parsed.task}`);
      console.log(`  Model: ${spawnedAgent.config.model}`);
      console.log(`\nUse /agents to check status, /join ${spawnedAgent.id} to wait for completion.`);
    } catch (err) {
      console.error(`\x1b[31mFailed to spawn agent: ${err}\x1b[0m`);
    }
    return true;
  }

  if (trimmed === "/agents") {
    const pool = getAgentPool();
    const agents = pool.listAgents();
    const stats = pool.getStats();

    console.log(`\n\x1b[36mAgent Pool:\x1b[0m`);
    console.log(`  Running: ${stats.running}/${pool.getMaxConcurrent()} | Completed: ${stats.completed} | Failed: ${stats.failed}\n`);

    if (agents.length === 0) {
      console.log("  No agents. Use /spawn <task> to create one.");
    } else {
      for (const spawnedAgent of agents) {
        console.log(`  ${formatAgentStatus(spawnedAgent)}`);
      }
    }
    return true;
  }

  if (trimmed.startsWith("/join ")) {
    const agentId = trimmed.slice(6).trim();
    const pool = getAgentPool();

    const spawnedAgent = pool.getAgent(agentId);
    if (!spawnedAgent) {
      console.log(`\x1b[31mAgent not found: ${agentId}\x1b[0m`);
      return true;
    }

    if (spawnedAgent.status === "completed" || spawnedAgent.status === "failed") {
      console.log(`\n\x1b[36mAgent ${agentId}:\x1b[0m ${spawnedAgent.status}`);
      if (spawnedAgent.task.result) {
        console.log(`\x1b[32mResult:\x1b[0m ${String(spawnedAgent.task.result).slice(0, 500)}`);
      }
      if (spawnedAgent.task.error) {
        console.log(`\x1b[31mError:\x1b[0m ${spawnedAgent.task.error}`);
      }
    } else {
      console.log(`\x1b[33mWaiting for agent ${agentId} to complete...\x1b[0m`);
      try {
        const result = await pool.joinAgent(agentId, 300000);
        console.log(`\n\x1b[32mAgent completed:\x1b[0m`);
        if (result.task.result) {
          console.log(String(result.task.result).slice(0, 500));
        }
      } catch (err) {
        console.error(`\x1b[31mError waiting for agent: ${err}\x1b[0m`);
      }
    }
    return true;
  }

  if (trimmed.startsWith("/kill ")) {
    const agentId = trimmed.slice(6).trim();
    const pool = getAgentPool();

    const killed = pool.cancelAgent(agentId);
    if (killed) {
      console.log(`\n\x1b[32mAgent killed:\x1b[0m ${agentId}`);
    } else {
      console.log(`\x1b[31mCould not kill agent ${agentId} (not found or already completed)\x1b[0m`);
    }
    return true;
  }

  // Subagent commands
  if (trimmed.startsWith("/agent ")) {
    const agentId = trimmed.slice(7).trim();
    try {
      const { getSubAgentManager, formatSubAgentStatus, formatSubAgentEvidence } = await import("../orchestration/subagent");
      const subAgentMgr = getSubAgentManager();
      const subAgent = subAgentMgr.getStatus(agentId);

      if (!subAgent) {
        console.log(`\x1b[31mSubagent not found: ${agentId}\x1b[0m`);
      } else {
        console.log(`\n\x1b[36mSubagent Details:\x1b[0m`);
        console.log(`  ${formatSubAgentStatus(subAgent)}`);
        console.log(`\n  Task: ${subAgent.task}`);
        console.log(`  Status: ${subAgent.status}`);
        console.log(`  Steps: ${subAgent.plan.length}`);
        console.log(`\n${formatSubAgentEvidence(subAgent)}`);

        if (subAgent.validationReport) {
          console.log(`\n\x1b[36mValidation Report:\x1b[0m`);
          console.log(`  Confidence: ${subAgent.validationReport.confidence}%`);
          console.log(`  Passed: ${subAgent.validationReport.passedSteps}/${subAgent.validationReport.totalSteps}`);
          console.log(`  Evidence: ${subAgent.validationReport.evidence.length} items`);
        }
      }
    } catch (err) {
      console.error(`\x1b[31mError: ${err}\x1b[0m`);
    }
    return true;
  }

  if (trimmed === "/evidence") {
    try {
      const { getSubAgentManager } = await import("../orchestration/subagent");
      const { formatEvidence, summarizeEvidence } = await import("../validation/evidence");
      const subAgentMgr = getSubAgentManager();
      const agents = subAgentMgr.listAgents();

      console.log(`\n\x1b[36mCollected Evidence:\x1b[0m\n`);

      let totalEvidence: import("../validation/evidence").Evidence[] = [];
      for (const agent of agents) {
        if (agent.evidence.length > 0) {
          console.log(`\x1b[33m${agent.id}:\x1b[0m ${agent.task.slice(0, 40)}...`);
          console.log(formatEvidence(agent.evidence));
          console.log("");
          totalEvidence = totalEvidence.concat(agent.evidence);
        }
      }

      if (totalEvidence.length === 0) {
        console.log("  No evidence collected yet.");
        console.log("  Evidence is collected when subagents execute tasks.");
      } else {
        const summary = summarizeEvidence(totalEvidence);
        console.log(`\x1b[36mTotal:\x1b[0m ${summary.total} items | ${summary.verified} verified | ${summary.failed} failed`);
      }
    } catch (err) {
      console.error(`\x1b[31mError: ${err}\x1b[0m`);
    }
    return true;
  }

  return false;
}

function handleTaskCommands(trimmed: string): boolean {
  if (trimmed === "/tasks" || trimmed === "/tasks -v" || trimmed === "/tasks --verbose") {
    const taskMgr = getTaskManager();
    const tasks = taskMgr.listTasks();
    const stats = taskMgr.getStats();
    const verbose = trimmed.includes("-v") || trimmed.includes("--verbose");

    console.log(`\n\x1b[36mTasks:\x1b[0m ${stats.total} total | ${stats.pending} pending | ${stats.inProgress} in progress | ${stats.completed} done\n`);

    if (tasks.length === 0) {
      console.log("  No tasks. Use /task \"description\" to create one.");
    } else {
      for (const task of tasks) {
        console.log(`  ${formatTask(task, verbose)}`);
      }
    }
    return true;
  }

  const taskCmd = parseTaskCommand(trimmed);
  if (taskCmd) {
    const taskMgr = getTaskManager();

    switch (taskCmd.action) {
      case "create":
        if (!taskCmd.subject) {
          console.log("\x1b[31mUsage: /task \"description\" [--priority high] [--tag tag1]\x1b[0m");
        } else {
          const task = taskMgr.createTask(taskCmd.subject, "", {
            priority: taskCmd.options.priority,
            tags: taskCmd.options.tags,
            owner: taskCmd.options.owner,
          });
          console.log(`\n\x1b[32mTask created:\x1b[0m ${task.id}`);
          console.log(`  ${formatTask(task)}`);
        }
        break;

      case "done":
        if (!taskCmd.taskId) {
          console.log("\x1b[31mUsage: /task:done <task-id>\x1b[0m");
        } else {
          const task = taskMgr.completeTask(taskCmd.taskId);
          if (task) {
            console.log(`\n\x1b[32mTask completed:\x1b[0m ${formatTask(task)}`);
          } else {
            console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
          }
        }
        break;

      case "start":
        if (!taskCmd.taskId) {
          console.log("\x1b[31mUsage: /task:start <task-id>\x1b[0m");
        } else {
          const task = taskMgr.startTask(taskCmd.taskId);
          if (task) {
            console.log(`\n\x1b[33mTask started:\x1b[0m ${formatTask(task)}`);
          } else {
            console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
          }
        }
        break;

      case "delete":
        if (!taskCmd.taskId) {
          console.log("\x1b[31mUsage: /task:delete <task-id>\x1b[0m");
        } else {
          const deleted = taskMgr.deleteTask(taskCmd.taskId);
          if (deleted) {
            console.log(`\n\x1b[32mTask deleted:\x1b[0m ${taskCmd.taskId}`);
          } else {
            console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
          }
        }
        break;

      case "show":
        if (!taskCmd.taskId) {
          console.log("\x1b[31mUsage: /task:show <task-id>\x1b[0m");
        } else {
          const task = taskMgr.getTask(taskCmd.taskId);
          if (task) {
            console.log(`\n${formatTask(task, true)}`);
            if (task.notes.length > 0) {
              console.log(`\n  Notes:`);
              for (const note of task.notes) {
                console.log(`    - ${note}`);
              }
            }
          } else {
            console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
          }
        }
        break;

      case "block":
        if (!taskCmd.taskId || !taskCmd.options.blockedBy) {
          console.log("\x1b[31mUsage: /task:block <task-id> <blocked-by-id>\x1b[0m");
        } else {
          const task = taskMgr.blockTask(taskCmd.taskId, taskCmd.options.blockedBy);
          if (task) {
            console.log(`\n\x1b[33mTask blocked:\x1b[0m ${formatTask(task)}`);
          } else {
            console.log(`\x1b[31mTask not found\x1b[0m`);
          }
        }
        break;
    }
    return true;
  }

  return false;
}

async function handleSkillInvocation(trimmed: string, agent: Agent): Promise<boolean> {
  if (trimmed.startsWith("/") && !trimmed.startsWith("/model") && !trimmed.startsWith("/plan")) {
    const skillCmd = parseSkillCommand(trimmed);
    if (skillCmd) {
      try {
        const skillManager = getSkillManager();
        await skillManager.loadSkills();
        const skill = skillManager.getSkill(skillCmd.name);

        if (skill) {
          console.log(`\n\x1b[36mInvoking skill:\x1b[0m ${skill.name}`);
          console.log(`\x1b[90m${skill.description}\x1b[0m\n`);

          let fullPrompt = `[SKILL: ${skill.name}]\n\n${skill.prompt}`;
          if (Object.keys(skillCmd.args).length > 0) {
            fullPrompt += `\n\n## Arguments\n${JSON.stringify(skillCmd.args, null, 2)}`;
          }

          try {
            const response = await agent.chat(fullPrompt);
            console.log(`\n\x1b[32m${response}\x1b[0m`);
          } catch (err) {
            console.error(`\x1b[31mSkill error: ${err}\x1b[0m`);
          }
          return true;
        }
      } catch {
        // Not a skill, continue to regular chat
      }
    }
  }

  return false;
}
