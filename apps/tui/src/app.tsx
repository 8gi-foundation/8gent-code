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
import { Box, Text, useInput, useApp } from "ink";
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
import {
  SelectInput,
  ModelSelector,
  ProviderSelector,
  type SelectOption,
  type ProviderOption,
} from "./components/select-input.js";

// Import permission system for infinite mode
import {
  enableInfiniteMode,
  disableInfiniteMode,
  isInfiniteMode,
} from "../../../packages/permissions/index.js";

// Import the actual Agent for real execution
import { Agent } from "../../../packages/agent/index.js";

// ============================================
// Types
// ============================================

interface AppProps {
  initialCommand: string;
  args: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

type ProcessingStage = "planning" | "toolshed" | "executing" | "complete";
type AppStatus = "idle" | "thinking" | "executing" | "success" | "error";
type ViewMode = "chat" | "kanban" | "avenues" | "predict" | "model-select" | "provider-select";

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
  const [tokensSaved, setTokensSaved] = useState(0);
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
  const [currentModel, setCurrentModel] = useState("glm-4.7-flash:latest");
  const [currentProvider, setCurrentProvider] = useState("ollama");
  const [availableModels] = useState([
    "glm-4.7-flash:latest",
    "qwen2.5-coder:14b",
    "llama3:8b",
    "mistral:7b",
    "codellama:13b",
    "deepseek-coder:6.7b",
  ]);
  const [availableProviders] = useState<ProviderOption[]>([
    { name: "ollama", displayName: "Ollama (Local)", hasApiKey: true, enabled: true },
    { name: "lmstudio", displayName: "LM Studio (Local)", hasApiKey: true, enabled: true },
    { name: "openrouter", displayName: "OpenRouter", hasApiKey: false, enabled: true },
    { name: "groq", displayName: "Groq", hasApiKey: false, enabled: true },
    { name: "openai", displayName: "OpenAI", hasApiKey: false, enabled: true },
    { name: "anthropic", displayName: "Anthropic", hasApiKey: false, enabled: true },
    { name: "mistral", displayName: "Mistral AI", hasApiKey: false, enabled: true },
  ]);

  // Agent instance for real execution
  const [agent, setAgent] = useState<Agent | null>(null);
  const [agentReady, setAgentReady] = useState(false);

  // Handle keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (soundEnabled) playSound("notification");
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
        const runtime = currentProvider === "lmstudio" ? "lmstudio" : "ollama";

        const newAgent = new Agent({
          model: currentModel,
          runtime: runtime as "ollama" | "lmstudio",
          workingDirectory: process.cwd(),
          maxTurns: 50,
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
              `  Tokens saved: ${tokensSaved.toLocaleString()}\n` +
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
      tokensSaved,
      recentCommands,
      currentBranch,
      showAnimations,
      soundEnabled,
      exit,
      availableModels,
      availableProviders,
    ]
  );

  // Simulate processing stages
  const simulateProcessing = useCallback(() => {
    const stages: ProcessingStage[] = ["planning", "toolshed", "executing", "complete"];
    let stageIndex = 0;

    const advanceStage = () => {
      if (stageIndex < stages.length) {
        setProcessingStage(stages[stageIndex]);
        setStatus(stageIndex < 2 ? "thinking" : "executing");
        stageIndex++;

        if (stageIndex < stages.length) {
          setTimeout(advanceStage, 300 + Math.random() * 400);
        }
      }
    };

    advanceStage();
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
    setStatus("thinking");

    // Start processing simulation
    simulateProcessing();

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
        setStatus("success");

        // Estimate token savings from AST-first approach
        const saved = Math.floor(response.length * 0.4);
        setTokensSaved((prev) => prev + saved);
        setContextSize(response.length);

        if (soundEnabled) {
          playSound("success");
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
        setStatus("success");

        const saved = Math.floor(Math.random() * 1500) + 500;
        setTokensSaved((prev) => prev + saved);
        setContextSize(Math.floor(Math.random() * 8000) + 2000);

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
    <Box flexDirection="column" height="100%">
      {/* Header */}
      {fancyHeader ? (
        <FancyHeader isProcessing={isProcessing} />
      ) : (
        <Header isProcessing={isProcessing} showAnimations={showAnimations} />
      )}

      {/* Main content area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {renderMainContent()}
      </Box>

      {/* Mini kanban when in chat mode and has items */}
      {viewMode === "chat" && (kanbanBoard.ready.length > 0 || kanbanBoard.inProgress.length > 0) && (
        <Box paddingX={1} marginBottom={1}>
          <MiniKanban board={kanbanBoard as any} />
        </Box>
      )}

      {/* Command input with ghost suggestions */}
      <CommandInput
        onSubmit={handleSubmit}
        isProcessing={isProcessing}
        processingStage={processingStage}
        showAnimations={showAnimations}
        isGitRepo={isGitRepo}
        currentBranch={currentBranch}
        planNextStep={planNextStep}
        recentCommands={recentCommands}
        onSlashCommand={handleSlashCommand}
      />

      {/* Status bar */}
      {showEnhancedStatus ? (
        <EnhancedStatusBar
          modelName={currentModel}
          runningAgents={isProcessing ? 1 : 0}
          totalAgents={1}
          permissionMode={infiniteModeActive ? "infinite" : "ask"}
          tokensSaved={tokensSaved}
          currentBranch={currentBranch}
          startTime={startTime}
          planStatus={
            isProcessing
              ? processingStage === "planning"
                ? "planning"
                : "executing"
              : kanbanBoard.done.length > 0
              ? "completed"
              : "idle"
          }
          planStepsCompleted={kanbanBoard.done.length}
          planStepsTotal={
            kanbanBoard.backlog.length +
            kanbanBoard.ready.length +
            kanbanBoard.inProgress.length +
            kanbanBoard.done.length
          }
          showAnimations={showAnimations}
        />
      ) : (
        <StatusBar
          tokensSaved={tokensSaved}
          status={status}
          showAnimations={showAnimations}
          soundEnabled={soundEnabled}
        />
      )}

      {/* Hidden keyboard shortcuts hint */}
      {showAnimations && (
        <Box paddingX={1} marginTop={1}>
          <Text color="gray" dimColor>
            ^A animations | ^S sound | ^H header | ^K kanban | ^P predict | /help | ^C exit
          </Text>
        </Box>
      )}
    </Box>
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
