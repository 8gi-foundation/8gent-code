#!/usr/bin/env bun
/**
 * 8gent Code - Interactive Install Wizard
 *
 * Sexy TUI installer that sets up a local AI coding assistant.
 * No API keys. No cloud. Just vibes.
 */

import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import Gradient from "ink-gradient";
import BigText from "ink-big-text";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

// ============================================
// Dynamic Model Discovery
// ============================================

// Coding-focused model identifiers to look for
const CODING_MODEL_PATTERNS = [
  "qwen", "coder", "deepseek", "codellama", "starcoder",
  "glm", "mimo", "code", "dev", "wizard"
];

async function fetchLatestModels(memoryGB: number): Promise<ModelOption[]> {
  const models: ModelOption[] = [];

  try {
    // Fetch available models from Ollama's library
    const response = await fetch("https://ollama.com/api/tags", {
      signal: AbortSignal.timeout(8000),
    });

    if (response.ok) {
      const data = await response.json();
      // Filter for coding models and sort by recent updates
      // Structure varies, use fallback if parsing fails
    }
  } catch {
    // Network unavailable, continue to fallback
  }

  // Also check what's already installed locally
  const installed = await getInstalledModels();
  for (const model of installed) {
    const isCoderModel = CODING_MODEL_PATTERNS.some(p =>
      model.toLowerCase().includes(p)
    );
    if (isCoderModel && !models.find(m => m.value === model)) {
      models.unshift({
        label: `${model} (installed)`,
        value: model,
        size: "Already downloaded",
        minRAM: 0,
        description: "Already on your system. Fastest option.",
      });
    }
  }

  // Merge with fallback models (prioritize installed)
  const fallbackFiltered = FALLBACK_MODELS.filter(
    m => !models.find(existing => existing.value === m.value)
  );

  return [...models, ...fallbackFiltered].filter(m => m.minRAM <= memoryGB + 8);
}

// Check Ollama for available models
async function getInstalledModels(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("ollama list 2>/dev/null");
    return stdout.split("\n")
      .slice(1) // Skip header
      .map(line => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================
// Types
// ============================================

interface SystemInfo {
  platform: string;
  arch: string;
  memory: number;
  memoryGB: number;
  cpuModel: string;
  hasGPU: boolean;
  gpuType: "apple" | "nvidia" | "amd" | "none";
  ollamaInstalled: boolean;
}

interface ModelOption {
  label: string;
  value: string;
  size: string;
  minRAM: number;
  description: string;
}

type Step = "welcome" | "detecting" | "model-select" | "installing" | "downloading" | "complete" | "error";

// ============================================
// Constants
// ============================================

// Fallback model registry - models known to work well for coding
// The installer will also check Ollama's live registry for newer options
const FALLBACK_MODELS: ModelOption[] = [
  // Large models (powerful hardware)
  {
    label: "Qwen 2.5 Coder 32B",
    value: "qwen2.5-coder:32b",
    size: "~20GB",
    minRAM: 32,
    description: "Strong coding benchmarks. Good for M2/M3 Max or RTX 4090.",
  },
  {
    label: "DeepSeek Coder V2 16B",
    value: "deepseek-coder-v2:16b",
    size: "~10GB",
    minRAM: 16,
    description: "MoE architecture. Great coding performance.",
  },
  {
    label: "CodeLlama 34B",
    value: "codellama:34b",
    size: "~19GB",
    minRAM: 32,
    description: "Meta's largest coding model.",
  },
  // Medium models (good hardware)
  {
    label: "Qwen 2.5 Coder 14B",
    value: "qwen2.5-coder:14b",
    size: "~9GB",
    minRAM: 16,
    description: "Balanced speed and quality.",
  },
  {
    label: "CodeLlama 13B",
    value: "codellama:13b",
    size: "~7GB",
    minRAM: 12,
    description: "Solid all-around coding model.",
  },
  // Small models (any hardware)
  {
    label: "Qwen 2.5 Coder 7B",
    value: "qwen2.5-coder:7b",
    size: "~4.5GB",
    minRAM: 8,
    description: "Fast and capable. Works on laptops.",
  },
  {
    label: "DeepSeek Coder V2 Lite",
    value: "deepseek-coder-v2:lite",
    size: "~4GB",
    minRAM: 8,
    description: "Lightweight but powerful.",
  },
  {
    label: "CodeLlama 7B",
    value: "codellama:7b",
    size: "~3.8GB",
    minRAM: 8,
    description: "Smallest, fastest option.",
  },
];

// ============================================
// Components
// ============================================

const Logo = () => (
  <Box flexDirection="column" alignItems="center" marginBottom={1}>
    <Gradient name="vice">
      <BigText text="8gent" font="chrome" />
    </Gradient>
    <Text color="gray">Never hit usage caps again™</Text>
  </Box>
);

const ProgressBar = ({ progress, width = 40 }: { progress: number; width?: number }) => {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return (
    <Box>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(empty)}</Text>
      <Text color="white"> {Math.round(progress * 100)}%</Text>
    </Box>
  );
};

const SystemCard = ({ info }: { info: SystemInfo }) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="cyan"
    paddingX={2}
    paddingY={1}
    marginY={1}
  >
    <Text color="cyan" bold>System Detected</Text>
    <Text>
      <Text color="gray">Platform: </Text>
      <Text color="white">{info.platform} ({info.arch})</Text>
    </Text>
    <Text>
      <Text color="gray">Memory:   </Text>
      <Text color={info.memoryGB >= 16 ? "green" : "yellow"}>{info.memoryGB}GB RAM</Text>
    </Text>
    <Text>
      <Text color="gray">CPU:      </Text>
      <Text color="white">{info.cpuModel}</Text>
    </Text>
    <Text>
      <Text color="gray">GPU:      </Text>
      <Text color={info.gpuType !== "none" ? "green" : "yellow"}>
        {info.gpuType === "apple" ? "Apple Silicon (Metal)" :
         info.gpuType === "nvidia" ? "NVIDIA (CUDA)" :
         info.gpuType === "amd" ? "AMD (ROCm)" : "CPU Only"}
      </Text>
    </Text>
    <Text>
      <Text color="gray">Ollama:   </Text>
      <Text color={info.ollamaInstalled ? "green" : "yellow"}>
        {info.ollamaInstalled ? "Installed ✓" : "Not installed"}
      </Text>
    </Text>
  </Box>
);

const ModelCard = ({ model, recommended }: { model: ModelOption; recommended: boolean }) => (
  <Box flexDirection="column" marginLeft={2}>
    <Text>
      <Text color="white">{model.label}</Text>
      {recommended && <Text color="green"> (Recommended)</Text>}
    </Text>
    <Text color="gray">   {model.size} • Min {model.minRAM}GB RAM</Text>
    <Text color="gray">   {model.description}</Text>
  </Box>
);

// ============================================
// Main App
// ============================================

const InstallerApp = () => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("welcome");
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState("");

  // Detect system on mount
  useEffect(() => {
    if (step === "detecting") {
      detectSystem();
    }
  }, [step]);

  // Handle keyboard input
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
    if (step === "welcome" && (key.return || input === " ")) {
      setStep("detecting");
    }
  });

  const detectSystem = async () => {
    try {
      const platform = os.platform();
      const arch = os.arch();
      const memory = os.totalmem();
      const memoryGB = Math.round(memory / (1024 * 1024 * 1024));
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model || "Unknown CPU";

      // Detect GPU type
      let gpuType: SystemInfo["gpuType"] = "none";
      if (platform === "darwin" && arch === "arm64") {
        gpuType = "apple";
      } else {
        try {
          await execAsync("nvidia-smi");
          gpuType = "nvidia";
        } catch {
          try {
            await execAsync("rocm-smi");
            gpuType = "amd";
          } catch {
            gpuType = "none";
          }
        }
      }

      // Check if Ollama is installed
      let ollamaInstalled = false;
      try {
        await execAsync("which ollama");
        ollamaInstalled = true;
      } catch {
        ollamaInstalled = false;
      }

      setSystemInfo({
        platform,
        arch,
        memory,
        memoryGB,
        cpuModel,
        hasGPU: gpuType !== "none",
        gpuType,
        ollamaInstalled,
      });

      // Auto-select recommended model based on RAM
      const recommended = FALLBACK_MODELS.find(m => m.minRAM <= memoryGB) || FALLBACK_MODELS[FALLBACK_MODELS.length - 1];
      setSelectedModel(recommended.value);

      setTimeout(() => setStep("model-select"), 1500);
    } catch (err) {
      setError(`Failed to detect system: ${err}`);
      setStep("error");
    }
  };

  const installOllama = async () => {
    setStep("installing");
    setStatusMessage("Installing Ollama...");

    try {
      if (os.platform() === "darwin") {
        // macOS - use brew
        await execAsync("brew install ollama");
      } else if (os.platform() === "linux") {
        // Linux - use curl script
        await execAsync("curl -fsSL https://ollama.com/install.sh | sh");
      } else {
        throw new Error("Please install Ollama manually from https://ollama.com");
      }

      setSystemInfo(prev => prev ? { ...prev, ollamaInstalled: true } : null);
      downloadModel();
    } catch (err) {
      setError(`Failed to install Ollama: ${err}`);
      setStep("error");
    }
  };

  const downloadModel = async () => {
    setStep("downloading");
    setStatusMessage(`Downloading ${selectedModel}...`);
    setDownloadProgress(0);

    try {
      // Start ollama serve in background if not running
      try {
        await execAsync("pgrep -x ollama || ollama serve &");
        await new Promise(r => setTimeout(r, 2000)); // Wait for server to start
      } catch {
        // Ignore if already running
      }

      // Pull model with progress tracking
      const proc = spawn("ollama", ["pull", selectedModel], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let lastProgress = 0;
      proc.stdout?.on("data", (data) => {
        const output = data.toString();
        // Parse progress from ollama output
        const match = output.match(/(\d+)%/);
        if (match) {
          lastProgress = parseInt(match[1]) / 100;
          setDownloadProgress(lastProgress);
        }
      });

      proc.stderr?.on("data", (data) => {
        const output = data.toString();
        const match = output.match(/(\d+)%/);
        if (match) {
          lastProgress = parseInt(match[1]) / 100;
          setDownloadProgress(lastProgress);
        }
      });

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          if (code === 0) {
            setDownloadProgress(1);
            resolve();
          } else {
            reject(new Error(`Download failed with code ${code}`));
          }
        });
        proc.on("error", reject);
      });

      // Save config
      await saveConfig();
      setStep("complete");
    } catch (err) {
      setError(`Failed to download model: ${err}`);
      setStep("error");
    }
  };

  const saveConfig = async () => {
    const configDir = path.join(os.homedir(), ".8gent");
    const configPath = path.join(configDir, "config.json");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const config = {
      version: "0.1.0",
      installedAt: new Date().toISOString(),
      model: selectedModel,
      runtime: "ollama",
      systemInfo,
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  };

  const handleModelSelect = (item: { value: string }) => {
    setSelectedModel(item.value);
  };

  const handleInstall = () => {
    if (!systemInfo?.ollamaInstalled) {
      installOllama();
    } else {
      downloadModel();
    }
  };

  // ============================================
  // Render
  // ============================================

  return (
    <Box flexDirection="column" padding={1}>
      <Logo />

      {step === "welcome" && (
        <Box flexDirection="column" alignItems="center">
          <Box
            borderStyle="double"
            borderColor="magenta"
            paddingX={3}
            paddingY={1}
            marginY={1}
          >
            <Text>
              Welcome to <Text color="cyan" bold>8gent Code</Text> — the free, local AI coding assistant.
            </Text>
          </Box>
          <Text color="gray" marginTop={1}>
            This wizard will set up everything you need:
          </Text>
          <Box flexDirection="column" marginY={1} marginLeft={2}>
            <Text>  <Text color="green">✓</Text> Detect your hardware</Text>
            <Text>  <Text color="green">✓</Text> Install Ollama (if needed)</Text>
            <Text>  <Text color="green">✓</Text> Download a coding model</Text>
            <Text>  <Text color="green">✓</Text> Configure 8gent</Text>
          </Box>
          <Text color="yellow" marginTop={1}>
            Press <Text bold>ENTER</Text> to begin or <Text bold>Q</Text> to quit
          </Text>
        </Box>
      )}

      {step === "detecting" && (
        <Box flexDirection="column" alignItems="center">
          <Box marginY={1}>
            <Text color="cyan">
              <Spinner type="dots" /> Detecting your system...
            </Text>
          </Box>
        </Box>
      )}

      {step === "model-select" && systemInfo && (
        <Box flexDirection="column">
          <SystemCard info={systemInfo} />

          <Text color="white" bold marginY={1}>
            Select a coding model:
          </Text>

          <SelectInput
            items={FALLBACK_MODELS.filter(m => m.minRAM <= systemInfo.memoryGB + 4).map(m => ({
              label: `${m.label} (${m.size})${m.value === selectedModel ? " ← Recommended" : ""}`,
              value: m.value,
            }))}
            onSelect={handleModelSelect}
            onHighlight={handleModelSelect}
          />

          <Box marginTop={1}>
            <Text color="gray">
              {FALLBACK_MODELS.find(m => m.value === selectedModel)?.description}
            </Text>
          </Box>

          <Box marginTop={2}>
            <Text color="yellow">
              Press <Text bold>ENTER</Text> to install
            </Text>
          </Box>

          {/* Hidden handler for enter */}
          <Box display="none">
            <SelectInput
              items={[{ label: "Install", value: "install" }]}
              onSelect={handleInstall}
            />
          </Box>
        </Box>
      )}

      {step === "installing" && (
        <Box flexDirection="column" alignItems="center">
          <Box marginY={1}>
            <Text color="cyan">
              <Spinner type="dots" /> {statusMessage}
            </Text>
          </Box>
          <Text color="gray">This may take a moment...</Text>
        </Box>
      )}

      {step === "downloading" && (
        <Box flexDirection="column" alignItems="center">
          <Box marginY={1}>
            <Text color="cyan">
              <Spinner type="dots" /> {statusMessage}
            </Text>
          </Box>
          <ProgressBar progress={downloadProgress} />
          <Text color="gray" marginTop={1}>
            {downloadProgress < 1 ? "Downloading model weights..." : "Finalizing..."}
          </Text>
        </Box>
      )}

      {step === "complete" && (
        <Box flexDirection="column" alignItems="center">
          <Box
            borderStyle="round"
            borderColor="green"
            paddingX={3}
            paddingY={1}
            marginY={1}
          >
            <Text color="green" bold>✓ Installation Complete!</Text>
          </Box>
          <Text marginY={1}>
            8gent Code is ready. Start coding with:
          </Text>
          <Box
            borderStyle="single"
            borderColor="gray"
            paddingX={2}
            paddingY={1}
            marginY={1}
          >
            <Text color="cyan">npx 8gent-code</Text>
          </Box>
          <Text color="gray" marginTop={1}>
            Model: <Text color="white">{selectedModel}</Text>
          </Text>
          <Text color="gray">
            Config: <Text color="white">~/.8gent/config.json</Text>
          </Text>
          <Text color="yellow" marginTop={2}>
            Press <Text bold>Q</Text> to exit
          </Text>
        </Box>
      )}

      {step === "error" && (
        <Box flexDirection="column" alignItems="center">
          <Box
            borderStyle="round"
            borderColor="red"
            paddingX={3}
            paddingY={1}
            marginY={1}
          >
            <Text color="red" bold>✗ Installation Failed</Text>
          </Box>
          <Text color="red" marginY={1}>{error}</Text>
          <Text color="gray">
            Please try again or install manually.
          </Text>
          <Text color="yellow" marginTop={2}>
            Press <Text bold>Q</Text> to exit
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ============================================
// Entry Point
// ============================================

render(<InstallerApp />);
