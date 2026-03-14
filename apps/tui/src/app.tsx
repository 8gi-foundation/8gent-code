/**
 * 8gent Code - Main App Component
 *
 * Fully animated TUI with:
 * - Gradient headers
 * - Typing animations
 * - Progress indicators
 * - Sound effects
 * - Rainbow borders
 * - Ghost text suggestions (Tab to accept)
 * - Slash commands (/kanban, /predict, /avenues)
 * - Proactive planning engine
 * - Multi-avenue tracking
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, useInput, useApp } from "ink";
import { Header, FancyHeader } from "./components/header.js";
import { StatusBar, DetailedStatusBar, EnhancedStatusBar } from "./components/status-bar.js";
import { CommandInput, SlashCommand } from "./components/command-input.js";
import { MessageList, StreamingMessage } from "./components/message-list.js";
import { soundManager, playSound } from "./components/sound-effects.js";
import {
  PlanKanban,
  AvenueDisplay,
  PredictedSteps,
  MiniKanban,
} from "./components/plan-kanban.js";
import { AnimatedStatusVerb } from "./components/status-verb.js";
import {
  SelectInput,
  ModelSelector,
  ProviderSelector,
  type SelectOption,
  type ProviderOption,
} from "./components/select-input.js";
import {
  AnimationShowcase,
  AnimationList,
  isValidAnimation,
  type AnimationType,
} from "./components/animation-showcase.js";
import {
  ADHDModeContext,
  ADHD_MODE_SUGGESTION,
  ADHD_MODE_ENABLED_MSG,
  ADHD_MODE_DISABLED_MSG,
} from "./components/bionic-text.js";
import { AppText, MutedText, Heading, Label, Inline, Stack, Divider, Spacer, ShortcutHint } from "./components/primitives/index.js";
import { ProcessSidebar, ProcessDetailView, ProcessBadge } from "./components/process-panel/index.js";
import { formatTokens } from "./lib/index.js";
import { useProcessPanel } from "./hooks/useProcessPanel.js";

// Import permission system for infinite mode
import {
  enableInfiniteMode,
  disableInfiniteMode,
  isInfiniteMode,
} from "../../../packages/permissions/index.js";

// Import the actual Agent for real execution
import { Agent } from "../../../packages/eight/index.js";
import type { AgentToolStartEvent, AgentToolEndEvent, AgentStepEvent } from "../../../packages/eight/index.js";

// Load .env file if present
import * as fs from "fs";
import * as pathMod from "path";

function loadEnvFile() {
  // Check multiple locations: cwd first, then the 8gent repo root
  const candidates = [
    pathMod.join(process.cwd(), ".env"),
    pathMod.resolve(import.meta.dirname, "../../../.env"), // 8gent-code repo root
    pathMod.join(process.env.HOME || "", ".8gent", ".env"), // ~/.8gent/.env
  ];
  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx > 0) {
              const key = trimmed.slice(0, eqIdx).trim();
              const val = trimmed.slice(eqIdx + 1).trim();
              if (!process.env[key]) {
                process.env[key] = val;
              }
            }
          }
        }
      }
    } catch {}
  }
}

function loadProviderSettings(): { provider: string; model: string } {
  try {
    const settingsPath = pathMod.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".8gent",
      "providers.json"
    );
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      return {
        provider: data.activeProvider || "ollama",
        model: data.activeModel || "glm-4.7-flash:latest",
      };
    }
  } catch {}
  return { provider: "ollama", model: "glm-4.7-flash:latest" };
}

loadEnvFile();
const _savedProviderSettings = loadProviderSettings();

// Import onboarding system
import { OnboardingManager } from "../../../packages/self-autonomy/index.js";

// Import design agent
import {
  DesignAgent,
  createDesignAgent,
  type DesignSuggestion,
} from "../../../packages/design-agent/index.js";
import { DesignSuggestionPanel } from "./components/design-selector.js";

// ============================================
// Types
// ============================================

interface AppProps {
  initialCommand: string;
  args: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: Date;
  /** For tool messages: whether the tool succeeded */
  toolSuccess?: boolean;
}

type ProcessingStage = "planning" | "toolshed" | "executing" | "complete";
type AppStatus = "idle" | "thinking" | "executing" | "success" | "error";
type ViewMode = "chat" | "kanban" | "avenues" | "predict" | "model-select" | "provider-select" | "onboarding" | "animations" | "design";

// Inline types for planning (to avoid import issues)
interface ProactiveStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  priority: number;
  confidence: number;
  category: string;
  predictedAt: Date;
  basedOn: string[];
}

interface KanbanBoard {
  backlog: ProactiveStep[];
  ready: ProactiveStep[];
  inProgress: ProactiveStep[];
  done: ProactiveStep[];
}

interface Avenue {
  id: string;
  name: string;
  description: string;
  probability: number;
  category: string;
  triggers: string[];
  plan: {
    goal: string;
    steps: Array<{
      id: string;
      description: string;
      tool: string;
    }>;
    estimatedTime: number;
  };
}

// ============================================
// Main App
// ============================================

export function App({ initialCommand, args }: AppProps) {
  const { exit } = useApp();

  // Personality greetings (inline for independence)
  const GREETINGS = [
    "Good day. What shall we build?",
    "Ah, a new task. Excellent.",
    "Ready to craft something magnificent?",
    "At your service. What's the mission?",
    "\u221E The infinite gentleman awaits.",
    "Splendid to see you. Where shall we begin?",
  ];
  const randomGreeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];

  // Core state
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "system",
      content: `\u221E 8gent Code - The Infinite Gentleman\n\n${randomGreeting}\n\nTry /help for commands, Tab for suggestions, or just ask.`,
      timestamp: new Date(),
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState<ProcessingStage>("planning");
  const [status, setStatus] = useState<AppStatus>("idle");

  // Real-time agent progress (replaces fake simulateProcessing)
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [stepCount, setStepCount] = useState(0);
  const [toolCount, setToolCount] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  // tokensSaved removed — using real totalTokens from agent events
  const [startTime] = useState(new Date());
  const [recentCommands, setRecentCommands] = useState<string[]>([]);

  // Animation settings
  const [showAnimations, setShowAnimations] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [fancyHeader, setFancyHeader] = useState(false);
  const [showEnhancedStatus, setShowEnhancedStatus] = useState(true);

  // Performance metrics
  const [lastResponseTime, setLastResponseTime] = useState<number | undefined>();
  const [contextSize, setContextSize] = useState<number | undefined>();

  // Context window tracking
  const [contextUsed, setContextUsed] = useState(0);
  const [contextMax] = useState(128000); // Default max context window

  // Expanded view state (Ctrl+O)
  const [expandedView, setExpandedView] = useState(false);

  // Git state (would be populated from actual git commands)
  const [isGitRepo] = useState(true);
  const [currentBranch] = useState<string | null>("main");

  // Planning state
  const [kanbanBoard, setKanbanBoard] = useState<KanbanBoard>({
    backlog: [],
    ready: [],
    inProgress: [],
    done: [],
  });
  const [avenues, setAvenues] = useState<Avenue[]>([]);
  const [predictedSteps, setPredictedSteps] = useState<ProactiveStep[]>([]);
  const [planNextStep, setPlanNextStep] = useState<string | null>(null);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("chat");

  // Infinite mode state
  const [infiniteModeActive, setInfiniteModeActive] = useState(false);

  // Model/Provider state (must be before agent init)
  const [currentModel, setCurrentModel] = useState(_savedProviderSettings.model);
  const [currentProvider, setCurrentProvider] = useState(_savedProviderSettings.provider);
  const [availableModels] = useState([
    "glm-4.7-flash:latest",
    "qwen2.5-coder:14b",
    "llama3:8b",
    "mistral:7b",
    "codellama:13b",
    "deepseek-coder:6.7b",
  ]);
  const [availableProviders] = useState<ProviderOption[]>([
    { name: "ollama", displayName: "Ollama (Local) - Free", hasApiKey: true, enabled: true },
    { name: "lmstudio", displayName: "LM Studio (Local) - Free", hasApiKey: true, enabled: true },
    { name: "openrouter-free", displayName: "OpenRouter (Free Models) 🆓", hasApiKey: true, enabled: true },
    { name: "openrouter", displayName: "OpenRouter (Paid Models)", hasApiKey: false, enabled: true },
    { name: "groq", displayName: "Groq (Free Tier)", hasApiKey: false, enabled: true },
    { name: "openai", displayName: "OpenAI", hasApiKey: false, enabled: true },
    { name: "anthropic", displayName: "Anthropic", hasApiKey: false, enabled: true },
    { name: "mistral", displayName: "Mistral AI", hasApiKey: false, enabled: true },
  ]);

  // Agent instance for real execution
  const [agent, setAgent] = useState<Agent | null>(null);
  const [agentReady, setAgentReady] = useState(false);

  // Background process panel
  const processPanel = useProcessPanel();

  // Onboarding system
  const [onboardingManager] = useState(() => new OnboardingManager(process.cwd()));
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentOnboardingQuestion, setCurrentOnboardingQuestion] = useState<string | null>(null);

  // Animation showcase
  const [currentAnimation, setCurrentAnimation] = useState<AnimationType>("all");

  // ADHD/Bionic reading mode
  const [adhdMode, setAdhdMode] = useState(false);
  const [adhdSuggested, setAdhdSuggested] = useState(false);

  // Design agent state
  const [designAgent] = useState(() => createDesignAgent({ workingDirectory: process.cwd() }));
  const [designSuggestions, setDesignSuggestions] = useState<DesignSuggestion[]>([]);
  const [designIntro, setDesignIntro] = useState<string>("");
  const [selectedDesign, setSelectedDesign] = useState<DesignSuggestion | null>(null);

  // Handle keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (soundEnabled) playSound("notification");
      // Finalize session before exiting
      if (agent) agent.cleanup().catch(() => {});
      exit();
    }

    // Toggle animations with Ctrl+A
    if (key.ctrl && input === "a") {
      setShowAnimations((prev) => !prev);
    }

    // Toggle sound with Ctrl+S
    if (key.ctrl && input === "s") {
      setSoundEnabled((prev) => {
        const next = !prev;
        soundManager.setEnabled(next);
        if (next) playSound("success");
        return next;
      });
    }

    // Toggle fancy header with Ctrl+H
    if (key.ctrl && input === "h") {
      setFancyHeader((prev) => !prev);
    }

    // Toggle kanban with Ctrl+K
    if (key.ctrl && input === "k") {
      setViewMode((prev) => (prev === "kanban" ? "chat" : "kanban"));
    }

    // Toggle predict with Ctrl+P
    if (key.ctrl && input === "p") {
      setViewMode((prev) => (prev === "predict" ? "chat" : "predict"));
    }

    // Toggle expanded view with Ctrl+O (like Claude Code)
    if (key.ctrl && input === "o") {
      setExpandedView((prev) => !prev);
    }

    // Toggle process panel
    if (key.ctrl && input === "b") {
      processPanel.toggleSidebar();
    }

    // Cycle through modes with Shift+Tab
    if (key.shift && key.tab) {
      const modes: ViewMode[] = ["chat", "kanban", "avenues", "predict"];
      setViewMode((prev) => {
        const currentIndex = modes.indexOf(prev);
        if (currentIndex === -1) return "chat";
        return modes[(currentIndex + 1) % modes.length];
      });
    }

    // Escape to return to chat
    if (key.escape && viewMode !== "chat") {
      setViewMode("chat");
    }
  });

  // Add system message helper
  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `system-${Date.now()}`,
        role: "system" as const,
        content,
        timestamp: new Date(),
      },
    ]);
  }, []);

  // Initialize agent on mount and when model/provider changes
  useEffect(() => {
    const initAgent = async () => {
      try {
        // Map provider to runtime
        let runtime: "ollama" | "lmstudio" | "openrouter" = "ollama";
        if (currentProvider === "lmstudio") {
          runtime = "lmstudio";
        } else if (currentProvider === "openrouter" || currentProvider === "openrouter-free") {
          runtime = "openrouter";
        }

        const newAgent = new Agent({
          model: currentModel,
          runtime,
          workingDirectory: process.cwd(),
          maxTurns: 50,
          apiKey: process.env.OPENROUTER_API_KEY,
          events: {
            onToolStart: (event: AgentToolStartEvent) => {
              setActiveTool(event.toolName);
              setProcessingStage("executing");
              setStatus("executing");
              // Show tool call in message stream
              const argsPreview = JSON.stringify(event.args).slice(0, 80);
              setMessages((prev) => [...prev, {
                id: `tool-start-${event.toolCallId}`,
                role: "tool" as const,
                content: `→ ${event.toolName}(${argsPreview})`,
                timestamp: new Date(),
              }]);
            },
            onToolEnd: (event: AgentToolEndEvent) => {
              setToolCount((prev) => prev + 1);
              setActiveTool(null);
              // Detect command failures even when tool "succeeds"
              const isRealFailure = !event.success ||
                (event.resultPreview?.startsWith("Exit code ") && !event.resultPreview.startsWith("Exit code 0"));
              const duration = event.durationMs > 0 ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : "";
              let content: string;
              if (isRealFailure && event.resultPreview) {
                // Show the error message so user knows what happened
                const errMsg = event.resultPreview.slice(0, 120).split("\n").slice(0, 2).join(" ");
                content = `  ✗ ${errMsg}${duration}`;
              } else {
                content = `  ✓${duration}`;
              }
              setMessages((prev) => [...prev, {
                id: `tool-end-${event.toolCallId}`,
                role: "tool" as const,
                content,
                timestamp: new Date(),
                toolSuccess: !isRealFailure,
              }]);
            },
            onStepFinish: (event: AgentStepEvent) => {
              setStepCount((prev) => prev + 1);
              setTotalTokens((prev) => prev + event.usage.totalTokens);
              // Determine stage from step content
              if (event.toolCalls.length > 0) {
                setProcessingStage("executing");
                setStatus("executing");
              } else {
                setProcessingStage("toolshed");
                setStatus("thinking");
              }
            },
          },
        });
        // Check if provider is available
        const ready = await newAgent.isReady();
        if (ready) {
          setAgent(newAgent);
          setAgentReady(true);
        } else {
          setAgentReady(false);
        }
      } catch (err) {
        setAgentReady(false);
        console.error("Agent init error:", err);
      }
    };
    initAgent();
  }, [currentModel, currentProvider]);

  // Check onboarding status on mount
  useEffect(() => {
    const checkOnboarding = async () => {
      // Detect available integrations
      await onboardingManager.detectIntegrations();

      if (onboardingManager.needsOnboarding()) {
        setShowOnboarding(true);
        setViewMode("onboarding");
        const question = onboardingManager.getNextQuestion();
        if (question) {
          setCurrentOnboardingQuestion(question.question);
          // Use setMessages directly to avoid stale closure issue
          setMessages((prev) => [
            ...prev,
            {
              id: `onboard-${Date.now()}`,
              role: "system" as const,
              content: "∞ Welcome to 8gent, The Infinite Gentleman.\n\n" +
                "Before we begin, I'd like to learn about you.\n" +
                "(Type /skip to skip any question, /skip all to skip onboarding)\n\n" +
                question.question,
              timestamp: new Date(),
            },
          ]);
        }
      } else if (onboardingManager.shouldAskClarification()) {
        const clarification = onboardingManager.getClarificationQuestion();
        if (clarification) {
          setMessages((prev) => [
            ...prev,
            {
              id: `clarify-${Date.now()}`,
              role: "system" as const,
              content: `Quick question: ${clarification}`,
              timestamp: new Date(),
            },
          ]);
        }
      }
    };
    checkOnboarding();
  }, [onboardingManager]);

  // Handle slash commands
  const handleSlashCommand = useCallback(
    (command: SlashCommand, args: string[]) => {
      switch (command) {
        case "help":
          addSystemMessage(
            "Available commands:\n" +
              "  /kanban (Ctrl+K) - Toggle kanban board\n" +
              "  /predict (Ctrl+P) - Show predicted next steps\n" +
              "  /avenues - Show planned avenues\n" +
              "  /design [task] - Get design system suggestions\n" +
              "  /plan - Show current plan status\n" +
              "  /status - Show session status\n" +
              "  /clear - Clear messages\n" +
              "  /quit - Exit 8gent Code\n\n" +
              "Keyboard shortcuts:\n" +
              "  Tab - Accept ghost suggestion\n" +
              "  Ctrl+A - Toggle animations\n" +
              "  Ctrl+S - Toggle sound\n" +
              "  Ctrl+H - Toggle fancy header"
          );
          break;

        case "kanban":
          setViewMode((prev) => (prev === "kanban" ? "chat" : "kanban"));
          break;

        case "predict":
          setViewMode((prev) => (prev === "predict" ? "chat" : "predict"));
          break;

        case "avenues":
          setViewMode((prev) => (prev === "avenues" ? "chat" : "avenues"));
          break;

        case "plan":
          addSystemMessage(
            `Current plan status:\n` +
              `  Backlog: ${kanbanBoard.backlog.length} items\n` +
              `  Ready: ${kanbanBoard.ready.length} items\n` +
              `  In Progress: ${kanbanBoard.inProgress.length} items\n` +
              `  Done: ${kanbanBoard.done.length} items`
          );
          break;

        case "status":
          const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          addSystemMessage(
            `Session Status:\n` +
              `  Duration: ${mins}:${secs.toString().padStart(2, "0")}\n` +
              `  Tokens used: ${totalTokens.toLocaleString()}\n` +
              `  Commands: ${recentCommands.length}\n` +
              `  Branch: ${currentBranch || "N/A"}\n` +
              `  Animations: ${showAnimations ? "on" : "off"}\n` +
              `  Sound: ${soundEnabled ? "on" : "off"}`
          );
          break;

        case "clear":
          setMessages([
            {
              id: `cleared-${Date.now()}`,
              role: "system",
              content: "Screen cleared.",
              timestamp: new Date(),
            },
          ]);
          break;

        case "quit":
          if (agent) agent.cleanup().catch(() => {});
          exit();
          break;

        case "infinite":
          // Toggle infinite mode - bypasses ALL permission checks
          if (infiniteModeActive) {
            disableInfiniteMode();
            setInfiniteModeActive(false);
            addSystemMessage(
              "∞ INFINITE MODE DISABLED\n" +
              "Permission checks will resume."
            );
          } else {
            enableInfiniteMode();
            setInfiniteModeActive(true);
            addSystemMessage(
              "∞ INFINITE MODE ENABLED\n" +
              "All permissions bypassed. Autonomous execution until done.\n" +
              "No questions, no crashes stop me, self-healing errors.\n\n" +
              "Use /infinite again to disable."
            );
          }
          break;

        case "onboarding":
          // Start or restart onboarding
          onboardingManager.reset();
          setShowOnboarding(true);
          setViewMode("onboarding");
          const onboardQuestion = onboardingManager.getNextQuestion();
          if (onboardQuestion) {
            setCurrentOnboardingQuestion(onboardQuestion.question);
            addSystemMessage(
              "∞ Let's get to know each other.\n\n" + onboardQuestion.question
            );
          }
          break;

        case "preferences":
          // Show current preferences
          const user = onboardingManager.getUser();
          addSystemMessage(
            "∞ Your Preferences:\n\n" +
            `Name: ${user.identity.name || "Not set"}\n` +
            `Role: ${user.identity.role || "Not set"}\n` +
            `Style: ${user.identity.communicationStyle || "Not set"}\n` +
            `Language: ${user.identity.language}\n` +
            `Model: ${user.preferences.model.default || currentModel}\n` +
            `Provider: ${user.preferences.model.provider || currentProvider}\n` +
            `Voice: ${user.preferences.voice.enabled ? "Enabled" : "Disabled"}\n` +
            `Auto-commit: ${user.preferences.git.autoCommit ? "Yes" : "No"}\n` +
            `Understanding: ${Math.round(user.understanding.confidenceScore * 100)}%\n\n` +
            "Use /onboarding to reconfigure."
          );
          break;

        case "skip":
          // Skip onboarding question
          if (showOnboarding) {
            if (args[0] === "all") {
              onboardingManager.skipAll();
              setShowOnboarding(false);
              setViewMode("chat");
              addSystemMessage(
                "Understood. I'll ask again later.\n" +
                "(The more I know, the better I serve.)"
              );
            } else {
              const nextQ = onboardingManager.skipQuestion();
              if (nextQ) {
                setCurrentOnboardingQuestion(nextQ.question);
                addSystemMessage(nextQ.question);
              } else {
                setShowOnboarding(false);
                setViewMode("chat");
                addSystemMessage("Onboarding complete. Let's begin.");
              }
            }
          }
          break;

        case "animations":
          // Show animation showcase
          if (args.length > 0) {
            const animName = args[0].toLowerCase();
            if (isValidAnimation(animName)) {
              setCurrentAnimation(animName);
              setViewMode("animations");
            } else {
              addSystemMessage(
                `Unknown animation: "${args[0]}"\n\n` +
                "Available: matrix, fire, dna, stars, dots, glitch, confetti, wave, gradient, all"
              );
            }
          } else {
            // Show animation list
            setCurrentAnimation("all");
            setViewMode("animations");
          }
          break;

        case "adhd":
          // Toggle ADHD/bionic reading mode
          if (args.length > 0) {
            const setting = args[0].toLowerCase();
            if (setting === "on" || setting === "enable" || setting === "true") {
              setAdhdMode(true);
              addSystemMessage(ADHD_MODE_ENABLED_MSG);
            } else if (setting === "off" || setting === "disable" || setting === "false") {
              setAdhdMode(false);
              addSystemMessage(ADHD_MODE_DISABLED_MSG);
            } else {
              addSystemMessage(`Usage: /adhd [on|off]\nCurrent: ${adhdMode ? "enabled" : "disabled"}`);
            }
          } else {
            // Toggle
            const newMode = !adhdMode;
            setAdhdMode(newMode);
            addSystemMessage(newMode ? ADHD_MODE_ENABLED_MSG : ADHD_MODE_DISABLED_MSG);
          }
          break;

        case "design":
          // Trigger design agent manually
          const designTask = args.length > 0 ? args.join(" ") : "create a new UI component";
          designAgent.process(designTask).then((result) => {
            if (result.needsIntervention && result.suggestions) {
              setDesignIntro(result.message.split("\n")[0] || "Pick a design direction:");
              setDesignSuggestions(result.suggestions);
              setViewMode("design");
            } else {
              addSystemMessage("No design decisions needed for this task.\nTry: /design create a landing page");
            }
          });
          break;

        // Model selection - check if args provided
        default:
          // Handle /model command
          if (command === "model" as any) {
            if (args.length > 0) {
              // Direct model set: /model qwen2.5:14b
              const newModel = args.join(" ");
              if (availableModels.includes(newModel) || newModel.includes(":")) {
                setCurrentModel(newModel);
                addSystemMessage(`Model switched to: ${newModel}`);
              } else {
                addSystemMessage(`Unknown model: ${newModel}\nUse /model to see available options.`);
              }
            } else {
              // Show model selector
              setViewMode("model-select");
            }
          }
          // Handle /provider command
          else if (command === "provider" as any) {
            if (args.length > 0) {
              const newProvider = args[0].toLowerCase();
              const provider = availableProviders.find(p => p.name === newProvider);
              if (provider) {
                setCurrentProvider(newProvider);
                addSystemMessage(`Provider switched to: ${provider.displayName}`);
              } else {
                addSystemMessage(`Unknown provider: ${newProvider}\nUse /provider to see available options.`);
              }
            } else {
              // Show provider selector
              setViewMode("provider-select");
            }
          }
          break;
      }
    },
    [
      addSystemMessage,
      kanbanBoard,
      startTime,
      totalTokens,
      recentCommands,
      currentBranch,
      showAnimations,
      soundEnabled,
      exit,
      availableModels,
      availableProviders,
      infiniteModeActive,
      onboardingManager,
      showOnboarding,
      currentModel,
      currentProvider,
      designAgent,
    ]
  );

  // Reset agent progress for a new request
  const resetAgentProgress = useCallback(() => {
    setActiveTool(null);
    setStepCount(0);
    setToolCount(0);
    setTotalTokens(0);
    setProcessingStage("planning");
    setStatus("thinking");
  }, []);

  // Generate predictions based on input
  const generatePredictions = useCallback((input: string) => {
    const inputLower = input.toLowerCase();
    const predictions: ProactiveStep[] = [];

    // Generate context-aware predictions
    if (inputLower.includes("fix") || inputLower.includes("bug")) {
      predictions.push({
        id: `pred-${Date.now()}-1`,
        description: "Run tests to verify fix",
        tool: "exec",
        input: { command: "npm test" },
        priority: 9,
        confidence: 0.85,
        category: "test",
        predictedAt: new Date(),
        basedOn: [],
      });
    }

    if (inputLower.includes("add") || inputLower.includes("create")) {
      predictions.push({
        id: `pred-${Date.now()}-2`,
        description: "Create test file for new feature",
        tool: "write_file",
        input: {},
        priority: 7,
        confidence: 0.7,
        category: "test",
        predictedAt: new Date(),
        basedOn: [],
      });
    }

    // Always add some general predictions
    predictions.push(
      {
        id: `pred-${Date.now()}-3`,
        description: "Search for related code",
        tool: "search_symbols",
        input: { query: input.split(" ").slice(0, 3).join(" ") },
        priority: 6,
        confidence: 0.6,
        category: "exploration",
        predictedAt: new Date(),
        basedOn: [],
      },
      {
        id: `pred-${Date.now()}-4`,
        description: "Commit changes",
        tool: "exec",
        input: { command: "git commit" },
        priority: 5,
        confidence: 0.5,
        category: "git",
        predictedAt: new Date(),
        basedOn: [],
      }
    );

    return predictions.sort((a, b) => b.confidence * b.priority - a.confidence * a.priority);
  }, []);

  // Generate avenues based on input
  const generateAvenues = useCallback((input: string): Avenue[] => {
    const inputLower = input.toLowerCase();
    const avenues: Avenue[] = [];

    if (inputLower.includes("fix") || inputLower.includes("bug") || inputLower.includes("error")) {
      avenues.push({
        id: `avenue-${Date.now()}-1`,
        name: "Fix Bug",
        description: `Debug and fix: ${input.slice(0, 30)}...`,
        probability: 0.8,
        category: "bugfix",
        triggers: ["fix", "bug", "error"],
        plan: {
          goal: "Fix the reported issue",
          steps: [
            { id: "1", description: "Search for error", tool: "search_symbols" },
            { id: "2", description: "Get symbol details", tool: "get_symbol" },
            { id: "3", description: "Apply fix", tool: "edit_file" },
          ],
          estimatedTime: 120,
        },
      });
    }

    if (inputLower.includes("add") || inputLower.includes("create") || inputLower.includes("implement")) {
      avenues.push({
        id: `avenue-${Date.now()}-2`,
        name: "Implement Feature",
        description: `Build: ${input.slice(0, 30)}...`,
        probability: 0.7,
        category: "feature",
        triggers: ["add", "create", "implement"],
        plan: {
          goal: "Implement the new feature",
          steps: [
            { id: "1", description: "Search existing code", tool: "search_symbols" },
            { id: "2", description: "Create new file", tool: "write_file" },
            { id: "3", description: "Add tests", tool: "write_file" },
          ],
          estimatedTime: 180,
        },
      });
    }

    // Always add exploration avenue
    avenues.push({
      id: `avenue-${Date.now()}-3`,
      name: "Explore Codebase",
      description: `Understand: ${input.slice(0, 30)}...`,
      probability: 0.5,
      category: "explore",
      triggers: ["show", "find", "where", "what"],
      plan: {
        goal: "Understand the relevant code",
        steps: [
          { id: "1", description: "Get file outline", tool: "get_outline" },
          { id: "2", description: "Search symbols", tool: "search_symbols" },
        ],
        estimatedTime: 60,
      },
    });

    return avenues.sort((a, b) => b.probability - a.probability);
  }, []);

  // Handle command submission
  const handleSubmit = async (input: string) => {
    if (!input.trim()) return;

    // Handle onboarding answers first
    if (showOnboarding && !input.startsWith("/")) {
      const result = onboardingManager.processAnswer(input);
      if (result.success) {
        if (result.nextQuestion) {
          setCurrentOnboardingQuestion(result.nextQuestion.question);
          addSystemMessage(result.nextQuestion.question);
        } else {
          // Onboarding complete
          setShowOnboarding(false);
          setViewMode("chat");
          const user = onboardingManager.getUser();
          addSystemMessage(
            `∞ Splendid, ${user.identity.name || "friend"}.\n\n` +
            `I now understand you ${Math.round(user.understanding.confidenceScore * 100)}%.\n` +
            "Let's build something magnificent."
          );

          // Apply user preferences to current session
          if (user.preferences.model.provider) {
            setCurrentProvider(user.preferences.model.provider);
          }
          if (user.preferences.model.default) {
            setCurrentModel(user.preferences.model.default);
          }
        }
      } else {
        addSystemMessage("I didn't quite catch that. Please try again.");
      }
      return;
    }

    const cmdStartTime = Date.now();

    // Track command history
    setRecentCommands((prev) => [input, ...prev].slice(0, 20));

    // Add user message
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: input,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsProcessing(true);
    resetAgentProgress();

    // Generate predictions and avenues
    const newPredictions = generatePredictions(input);
    setPredictedSteps(newPredictions);
    setPlanNextStep(newPredictions[0]?.description || null);

    const newAvenues = generateAvenues(input);
    setAvenues(newAvenues);

    // Update kanban board
    setKanbanBoard((prev) => ({
      ...prev,
      ready: newPredictions.slice(0, 3) as any,
      backlog: newPredictions.slice(3) as any,
    }));

    // Use real agent if available, otherwise fall back to mock
    if (agent && agentReady) {
      // Real agent execution
      try {
        const response = await agent.chat(input);
        const endTime = Date.now();
        setLastResponseTime(endTime - cmdStartTime);

        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: response,
          timestamp: new Date(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setIsProcessing(false);
        setActiveTool(null);
        setStatus("success");

        if (soundEnabled) {
          playSound("success");
        }

        // Suggest ADHD mode after 3rd response if not already enabled or suggested
        if (!adhdMode && !adhdSuggested && messages.length >= 4) {
          setAdhdSuggested(true);
          setTimeout(() => {
            addSystemMessage(
              "💡 **Tip:** Try /adhd for faster reading!\n\n" +
              "ADHD mode **bo**lds the **fi**rst half of **ea**ch word, " +
              "helping your **br**ain process **te**xt faster.\n\n" +
              "Perfect for **co**de reviews. Type /adhd to try it."
            );
          }, 2000);
        }

        setTimeout(() => {
          setStatus("idle");
        }, 1500);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: `[Error] ${errorMsg}`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setIsProcessing(false);
        setActiveTool(null);
        setStatus("error");
        setTimeout(() => setStatus("idle"), 3000);
      }
    } else {
      // Mock mode fallback
      setTimeout(() => {
        const endTime = Date.now();
        setLastResponseTime(endTime - cmdStartTime);

        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: generateResponse(input),
          timestamp: new Date(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setIsProcessing(false);
        setActiveTool(null);
        setStatus("success");

        if (soundEnabled) {
          playSound("success");
        }

        setTimeout(() => {
          setStatus("idle");
        }, 1500);
      }, 800 + Math.random() * 600);
    }
  };

  // Render main content based on view mode
  const renderMainContent = () => {
    switch (viewMode) {
      case "kanban":
        return (
          <PlanKanban
            board={kanbanBoard as any}
            visible={true}
            onClose={() => setViewMode("chat")}
            compact={false}
          />
        );

      case "avenues":
        return (
          <AvenueDisplay
            avenues={avenues as any}
            visible={true}
            onAvenueSelect={() => setViewMode("chat")}
          />
        );

      case "predict":
        return (
          <PredictedSteps
            steps={predictedSteps as any}
            visible={true}
            onStepAccept={(id) => {
              // Move step to in progress
              setKanbanBoard((prev) => {
                const step = prev.ready.find((s) => s.id === id) || prev.backlog.find((s) => s.id === id);
                if (!step) return prev;
                return {
                  ...prev,
                  ready: prev.ready.filter((s) => s.id !== id),
                  backlog: prev.backlog.filter((s) => s.id !== id),
                  inProgress: [...prev.inProgress, step],
                };
              });
            }}
          />
        );

      case "model-select":
        return (
          <ModelSelector
            models={availableModels}
            currentModel={currentModel}
            onSelect={(model) => {
              setCurrentModel(model);
              addSystemMessage(`Model switched to: ${model}`);
              setViewMode("chat");
            }}
            onCancel={() => setViewMode("chat")}
            provider={currentProvider}
          />
        );

      case "provider-select":
        return (
          <ProviderSelector
            providers={availableProviders}
            currentProvider={currentProvider}
            onSelect={(provider) => {
              setCurrentProvider(provider);
              const p = availableProviders.find(pr => pr.name === provider);
              addSystemMessage(`Provider switched to: ${p?.displayName || provider}`);
              setViewMode("chat");
            }}
            onCancel={() => setViewMode("chat")}
          />
        );

      case "onboarding":
        // Onboarding uses the same message list but with a different header indicator
        return (
          <Stack>
            <Box marginBottom={1}>
              <Heading>∞ Onboarding</Heading>
              <MutedText> - </MutedText>
              <AppText color="yellow">Getting to know you</AppText>
            </Box>
            <MessageList
              messages={messages}
              animateTyping={showAnimations}
              soundEnabled={soundEnabled}
            />
          </Stack>
        );

      case "animations":
        // Animation showcase/gallery
        return (
          <AnimationShowcase
            animation={currentAnimation}
            onClose={() => setViewMode("chat")}
          />
        );

      case "design":
        // Design system selector
        return (
          <DesignSuggestionPanel
            intro={designIntro}
            suggestions={designSuggestions.map(s => ({
              id: s.id,
              name: s.name,
              description: s.description,
              reasoning: s.reasoning,
              score: s.score,
              stack: s.stack,
              preview: s.preview,
            }))}
            followUp="Which direction speaks to you? (1, 2, or 3)"
            onSelect={(option) => {
              designAgent.selectDesign(option.id).then((result) => {
                if (result.success && result.selectedDesign) {
                  setSelectedDesign(result.selectedDesign);
                  addSystemMessage(
                    `\u2713 Design selected: **${result.selectedDesign.name}**\n\n` +
                    `Stack: ${result.selectedDesign.stack.join(", ")}\n\n` +
                    (result.commands.length > 0
                      ? `Setup commands:\n${result.commands.map(c => `  $ ${c}`).join("\n")}\n\n`
                      : "") +
                    "I'll use this design system for the implementation."
                  );
                }
                setViewMode("chat");
              });
            }}
            onSkip={() => {
              addSystemMessage("Skipping design selection. I'll pick something sensible.");
              setViewMode("chat");
            }}
            visible={true}
          />
        );

      case "chat":
      default:
        return (
          <MessageList
            messages={messages}
            animateTyping={showAnimations}
            soundEnabled={soundEnabled}
          />
        );
    }
  };

  return (
    <ADHDModeContext.Provider value={{ enabled: adhdMode, ratio: 0.5 }}>
    <Box flexDirection="column" height="100%">
      {/* Header */}
      {fancyHeader ? (
        <FancyHeader isProcessing={isProcessing} />
      ) : (
        <Header isProcessing={isProcessing} showAnimations={showAnimations} />
      )}

      {/* Main content area — process views replace chat when active */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {processPanel.detailTaskId && processPanel.tasks.find(t => t.id === processPanel.detailTaskId) ? (
          <ProcessDetailView
            task={processPanel.tasks.find(t => t.id === processPanel.detailTaskId)!}
            output={processPanel.detailOutput}
            onClose={processPanel.closeDetail}
            onKill={() => {
              const killed = processPanel.killSelected();
              if (killed) {
                setMessages((prev) => [...prev, {
                  id: `system-kill-${Date.now()}`,
                  role: "system" as const,
                  content: `Process killed: "${killed.command.slice(0, 60)}"`,
                  timestamp: new Date(),
                }]);
              }
            }}
            height={30}
          />
        ) : processPanel.sidebarOpen ? (
          <ProcessSidebar
            tasks={processPanel.tasks}
            selectedIndex={processPanel.selectedIndex}
            focused={processPanel.focusZone === "sidebar"}
            taskCounts={processPanel.taskCounts}
            width={60}
            onNext={processPanel.nextTask}
            onPrev={processPanel.prevTask}
            onOpen={processPanel.openDetail}
            onKill={() => {
              const killed = processPanel.killSelected();
              if (killed) {
                setMessages((prev) => [...prev, {
                  id: `system-kill-${Date.now()}`,
                  role: "system" as const,
                  content: `Process killed: "${killed.command.slice(0, 60)}"`,
                  timestamp: new Date(),
                }]);
              }
            }}
            onUnfocus={processPanel.focusInput}
          />
        ) : (
          renderMainContent()
        )}
      </Box>

      {/* Mini kanban when in chat mode and has items */}
      {viewMode === "chat" && (kanbanBoard.ready.length > 0 || kanbanBoard.inProgress.length > 0) && (
        <Box paddingX={1} marginBottom={1}>
          <MiniKanban board={kanbanBoard as any} />
        </Box>
      )}

      {/* Status verb - always visible */}
      <Box paddingX={1} marginBottom={1}>
        {isProcessing ? (
          <AnimatedStatusVerb
            type={processingStage === "planning" ? "planning" : "executing"}
            showIcon={true}
            active={true}
          />
        ) : (
          <MutedText>
            <AppText color="cyan">✦</AppText> Awaiting your command...
          </MutedText>
        )}
      </Box>

      {/* Top separator line */}
      <Box paddingX={1}>
        <Divider />
      </Box>

      {/* Input section with context window display */}
      <Box paddingX={1} justifyContent="space-between" alignItems="center">
        {/* Left: Context used */}
        <Box width={12}>
          <MutedText>
            {formatTokens(totalTokens)}
          </MutedText>
        </Box>

        {/* Center: Command input */}
        <Box flexGrow={1}>
          <CommandInput
            onSubmit={handleSubmit}
            isProcessing={isProcessing}
            processingStage={processingStage}
            showAnimations={showAnimations}
            activeTool={activeTool}
            stepCount={stepCount}
            toolCount={toolCount}
            totalTokens={totalTokens}
            isGitRepo={isGitRepo}
            currentBranch={currentBranch}
            planNextStep={planNextStep}
            recentCommands={recentCommands}
            onSlashCommand={handleSlashCommand}
          />
        </Box>

        {/* Right: Context max */}
        <Box width={12} justifyContent="flex-end">
          <MutedText>
            /{formatTokens(contextMax)}
          </MutedText>
        </Box>
      </Box>

      {/* Bottom separator line */}
      <Box paddingX={1}>
        <Divider />
      </Box>

      {/* Expanded view panel (Ctrl+O) */}
      {expandedView && (
        <Box
          flexDirection="column"
          paddingX={1}
          borderStyle="single"
          borderColor="cyan"
          marginX={1}
          marginTop={1}
        >
          <Heading>∞ Extended Info</Heading>
          <Box marginTop={1} flexDirection="column">
            <MutedText>Model: <AppText color="cyan">{currentModel}</AppText> via <AppText color="magenta">{currentProvider}</AppText></MutedText>
            <MutedText>Agent: <AppText color={agentReady ? "green" : "red"}>{agentReady ? "ready" : "not connected"}</AppText></MutedText>
            <MutedText>Tokens: <AppText color="cyan">{totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}k` : "—"}</AppText> · Steps: <AppText color="cyan">{stepCount}</AppText> · Tools: <AppText color="cyan">{toolCount}</AppText></MutedText>
            <MutedText>Response time: <AppText color="yellow">{lastResponseTime ? `${(lastResponseTime / 1000).toFixed(1)}s` : "—"}</AppText></MutedText>
            {currentBranch && <MutedText>Branch: <AppText color="yellow">{currentBranch}</AppText></MutedText>}
            <MutedText>Infinite: <AppText color={infiniteModeActive ? "red" : "green"}>{infiniteModeActive ? "∞ enabled" : "disabled"}</AppText></MutedText>
          </Box>
          <Box marginTop={1}>
            <MutedText>Press Ctrl+O to close</MutedText>
          </Box>
        </Box>
      )}

      {/* Status bar */}
      {showEnhancedStatus ? (
        <EnhancedStatusBar
          modelName={currentModel}
          runningAgents={isProcessing ? 1 : 0}
          totalAgents={1}
          permissionMode={infiniteModeActive ? "infinite" : "ask"}
          tokensSaved={totalTokens}
          currentBranch={currentBranch}
          startTime={startTime}
          planStatus={
            isProcessing
              ? activeTool
                ? "executing"
                : "planning"
              : stepCount > 0
              ? "completed"
              : "idle"
          }
          planStepsCompleted={toolCount}
          planStepsTotal={stepCount}
          showAnimations={showAnimations}
          adhdMode={adhdMode}
        />
      ) : (
        <StatusBar
          tokensSaved={totalTokens}
          status={status}
          showAnimations={showAnimations}
          soundEnabled={soundEnabled}
        />
      )}

      {/* Hidden keyboard shortcuts hint */}
      {showAnimations && (
        <Box paddingX={1} marginTop={1} gap={2}>
          <MutedText>
            ^O expand | ^B processes | ^K kanban | ^P predict | ⇧Tab cycle | ^A anim | ^S sound | ^C exit
          </MutedText>
          {!processPanel.sidebarOpen && <ProcessBadge counts={processPanel.taskCounts} />}
        </Box>
      )}
    </Box>
    </ADHDModeContext.Provider>
  );
}

// Personality completion phrases
const COMPLETION_PHRASES = [
  "Splendid. Task complete.",
  "Another victory for elegant code.",
  "Infinity achieved, as always.",
  "The gentleman delivers.",
  "Perfection, if I do say so myself.",
  "Consider it done. Magnificently.",
  "Executed with characteristic grace.",
  "As expected, excellence prevails.",
];

// Generate a mock response with personality flavor (replace with actual agent logic)
function generateResponse(input: string): string {
  const completionPhrase = COMPLETION_PHRASES[Math.floor(Math.random() * COMPLETION_PHRASES.length)];

  const responses = [
    `[\u221E 8gent] Processing: "${input}"\n\n\u2713 Toolshed query complete\n\u2713 AST retrieval: 3 files analyzed\n\u2713 Context compression: 42% tokens saved\n\n${completionPhrase}`,

    `[\u221E 8gent] Analyzing request...\n\n\u25B8 Planner: Identified 2 subtasks\n\u25B8 Toolshed: Found 5 relevant symbols\n\u25B8 Execution: Preparing changes\n\nAST-first approach saved 1,247 tokens.\n\n${completionPhrase}`,

    `[\u221E 8gent] Query understood.\n\n\`\`\`typescript\n// Extracted context\nfunction processRequest(input: string) {\n  return analyze(input);\n}\n\`\`\`\n\nToken efficiency: 38% improvement over raw context.\n\n${completionPhrase}`,

    `[\u221E 8gent] Task complete.\n\n\u2022 Files analyzed: 7\n\u2022 Symbols extracted: 23\n\u2022 Context size: 2.1k tokens (vs 5.8k raw)\n\u2022 Savings: 64%\n\nStructured agentic development in action.\n\n${completionPhrase}`,
  ];

  return responses[Math.floor(Math.random() * responses.length)];
}
