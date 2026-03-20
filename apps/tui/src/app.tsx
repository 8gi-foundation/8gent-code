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

import React, { useState, useEffect, useCallback, useRef } from "react";
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
  AutoPlanKanban,
  AutoMiniKanban,
} from "./components/plan-kanban.js";
import { useAutoKanban } from "./hooks/useAutoKanban.js";
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
import { getADHDAudio, type ADHDSoundscape } from "./lib/adhd-audio.js";
import { getTaskRouter, getRouterStats, type TaskCategory } from "../../../packages/ai/task-router.js";
import { MusicPlayerView } from "./screens/MusicPlayerView.js";
import { NotesView } from "./screens/NotesView.js";
import { IdeasView } from "./screens/IdeasView.js";
import { BTWView } from "./screens/BTWView.js";
import { QuestionsView } from "./screens/QuestionsView.js";
import { ProjectsView } from "./screens/ProjectsView.js";
import { TabBar } from "./components/TabBar.js";
import { useWorkspaceTabs, type TabType } from "./hooks/useWorkspaceTabs.js";
import { AppText, MutedText, Heading, Label, Inline, Stack, Divider, Spacer, ShortcutHint } from "./components/primitives/index.js";
import { ProcessSidebar, ProcessDetailView, ProcessBadge } from "./components/process-panel/index.js";
import { formatTokens } from "./lib/index.js";
import { useProcessPanel } from "./hooks/useProcessPanel.js";
import { useImageInput, ImageBadge } from "./components/image-input.js";
import { FixedFrame } from "./components/fixed-frame/index.js";
import { type TaskItem } from "./components/task-card/index.js";
import { NarratorView } from "./screens/index.js";
import { narrateToolStart, narrateToolEnd, narratePlan, narrateStep } from "./lib/narrator.js";
import { useViewport } from "./hooks/useViewport.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { ThinkingView } from "./components/ThinkingView.js";
import { ActivityMonitor, pushActivity, completeActivity, clearActivity } from "./components/ActivityMonitor.js";
import { VoiceIndicator } from "./components/VoiceIndicator.js";
import { useVoiceInput } from "./hooks/useVoiceInput.js";
import { useVoiceChat } from "./hooks/useVoiceChat.js";
import { useAgentOrchestration } from "./hooks/useAgentOrchestration.js";
import { AgentIndicator } from "./components/agent-panel/AgentIndicator.js";
import { AgentSidebar } from "./components/agent-panel/AgentSidebar.js";
import { SpawnRequestCard } from "./components/agent-panel/SpawnRequestCard.js";
import { initSessionLogger, logMessage, logToolStart, logToolEnd, logStep, logError, logTabSwitch, flushSession } from "./lib/session-logger.js";

// Import auth + DB systems (lazy, non-blocking)
let authManager: any = null;
let convexClient: any = null;

async function initAuthSystem() {
  try {
    const { getAuthManager, initAuth } = await import("../../../packages/auth/index.js");
    const state = await initAuth();
    authManager = getAuthManager();

    // If authenticated, wire up Convex
    if (state.status === "authenticated") {
      try {
        const { getConvexClient } = await import("../../../packages/db/client.js");
        convexClient = getConvexClient();
        convexClient.setAuth(async () => authManager?.getAccessToken?.() ?? null);
      } catch {}
    }

    return state;
  } catch {
    // Auth packages not available — anonymous mode
    return { status: "anonymous" as const };
  }
}

// Import permission system for infinite mode
import {
  enableInfiniteMode,
  disableInfiniteMode,
  isInfiniteMode,
} from "../../../packages/permissions/index.js";

// Import the actual Agent for real execution
import { Agent } from "../../../packages/eight/index.js";
import type { AgentToolStartEvent, AgentToolEndEvent, AgentStepEvent, AgentEvidenceEvent, AgentEvidenceSummaryEvent } from "../../../packages/eight/index.js";

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
        model: data.activeModel || "qwen3.5:latest",
      };
    }
  } catch {}
  return { provider: "ollama", model: "qwen3.5:latest" };
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
type AgentMode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";
const AGENT_MODES: AgentMode[] = ["Planning", "Researching", "Implementing", "Testing", "Debugging"];
type AppStatus = "idle" | "thinking" | "executing" | "success" | "error";
type ViewMode = "chat" | "kanban" | "avenues" | "predict" | "model-select" | "provider-select" | "onboarding" | "animations" | "design" | "history" | "music";

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
  // Per-tab message storage (tab-aware logic wired after workspaceTabs hook below)
  const tabMessagesRef = useRef<Map<string, Message[]>>(new Map());
  const [messages, setMessagesRaw] = useState<Message[]>([
    {
      id: "welcome",
      role: "system",
      content: `\u221E 8gent Code \u2014 The Infinite Gentleman\n\n${randomGreeting}\n/help for commands, Tab for suggestions, or just ask.`,
      timestamp: new Date(),
    },
  ]);
  const [isProcessingRaw, setIsProcessingRaw] = useState(false);
  const processingTabIdRef = useRef<string | null>(null);
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

  // Auth state (non-blocking)
  const [authStatus, setAuthStatus] = useState<"unknown" | "anonymous" | "authenticated" | "error">("unknown");
  const [authUser, setAuthUser] = useState<{ displayName: string; plan: string } | null>(null);

  // Voice input — transcript goes to input field for review, NOT auto-send
  const [voiceTranscript, setVoiceTranscript] = useState<string | null>(null);
  const voice = useVoiceInput({
    onTranscript: (text) => {
      setVoiceTranscript(text);
      addSystemMessage(`Transcribed: "${text}" — edit or press Enter to send`);
    },
  });

  // Voice chat mode — full duplex voice conversation loop
  const voiceChat = useVoiceChat({
    onAgentMessage: async (transcript) => {
      if (!agent || !agentReady) return "Agent not ready.";
      // Add user message to chat
      setMessages((prev) => [...prev, {
        id: `voice-user-${Date.now()}`,
        role: "user" as const,
        content: `🎤 ${transcript}`,
        timestamp: new Date(),
      }]);
      try {
        const response = await agent.chat(transcript);
        // Add agent response to chat
        setMessages((prev) => [...prev, {
          id: `voice-agent-${Date.now()}`,
          role: "assistant" as const,
          content: response,
          timestamp: new Date(),
        }]);
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: ${msg}`;
      }
    },
    voice: "Daniel",
    silenceMs: 1500,
    onActiveChange: (active) => {
      if (active) {
        addSystemMessage("🎙️ Voice chat active. Speak naturally. ESC to stop, ESC during speech to interrupt.");
      } else {
        addSystemMessage("Voice chat ended.");
      }
    },
  });

  // Initialize auth on mount (fire-and-forget, never blocks)
  useEffect(() => {
    initAuthSystem().then((state) => {
      setAuthStatus(state.status === "authenticated" ? "authenticated" : "anonymous");
      if (state.status === "authenticated" && "user" in state) {
        setAuthUser({ displayName: (state as any).user?.displayName ?? "User", plan: (state as any).user?.plan ?? "free" });
      }
    }).catch(() => setAuthStatus("anonymous"));
  }, []);

  // Initialize session logger on mount
  useEffect(() => {
    const sessionId = `session-${Date.now()}`;
    initSessionLogger(sessionId, currentModel, currentProvider);
    return () => { flushSession(); };
  }, []);

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

  // Planning state (legacy predicted-step board)
  const [kanbanBoard, setKanbanBoard] = useState<KanbanBoard>({
    backlog: [],
    ready: [],
    inProgress: [],
    done: [],
  });

  // Auto-populating kanban from real agent events
  const autoKanban = useAutoKanban();
  const [avenues, setAvenues] = useState<Avenue[]>([]);
  const [predictedSteps, setPredictedSteps] = useState<ProactiveStep[]>([]);
  const [planNextStep, setPlanNextStep] = useState<string | null>(null);

  // View state — now driven by workspace tabs
  const [viewMode, setViewMode] = useState<ViewMode>("chat");

  // Workspace tabs
  const workspaceTabs = useWorkspaceTabs();
  const activeTabType = workspaceTabs.activeTab?.type || "chat";
  const activeTabId = workspaceTabs.activeTab?.id || "default";

  // Only show processing state when the active tab is the one that triggered it
  const isProcessing = isProcessingRaw && processingTabIdRef.current === activeTabId;
  const setIsProcessing = useCallback((val: boolean) => {
    setIsProcessingRaw(val);
    if (val) processingTabIdRef.current = activeTabId;
    else processingTabIdRef.current = null;
  }, [activeTabId]);

  // Per-tab message sync: save current tab's messages, load new tab's messages on switch
  const prevTabIdRef = useRef(activeTabId);
  useEffect(() => {
    if (prevTabIdRef.current !== activeTabId) {
      // Log tab switch for session debugger
      logTabSwitch(prevTabIdRef.current, activeTabId, workspaceTabs.activeTab?.title || "Chat");

      // Save outgoing tab's messages
      setMessagesRaw((currentMsgs) => {
        tabMessagesRef.current.set(prevTabIdRef.current, currentMsgs);
        return currentMsgs;
      });
      // Load incoming tab's messages (or create fresh welcome)
      const incoming = tabMessagesRef.current.get(activeTabId);
      if (incoming) {
        setMessagesRaw(incoming);
      } else {
        const fresh: Message[] = [{
          id: `welcome-${activeTabId}`,
          role: "system",
          content: `\u221E 8gent Code \u2014 The Infinite Gentleman\n\nNew thread. What shall we work on?`,
          timestamp: new Date(),
        }];
        tabMessagesRef.current.set(activeTabId, fresh);
        setMessagesRaw(fresh);
      }
      prevTabIdRef.current = activeTabId;
    }
  }, [activeTabId]);

  // setMessages wrapper that also updates the ref map for current tab
  const setMessages: React.Dispatch<React.SetStateAction<Message[]>> = useCallback((action) => {
    setMessagesRaw((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      tabMessagesRef.current.set(activeTabId, next);
      return next;
    });
  }, [activeTabId]);

  // Infinite mode state
  const [infiniteModeActive, setInfiniteModeActive] = useState(false);

  // Model/Provider state (must be before agent init)
  const [currentModel, setCurrentModel] = useState(_savedProviderSettings.model);
  const [currentProvider, setCurrentProvider] = useState(_savedProviderSettings.provider);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Fetch models dynamically based on selected provider
  useEffect(() => {
    let cancelled = false;
    const fetchModels = async () => {
      setModelsLoading(true);
      try {
        if (currentProvider === "ollama") {
          // Fetch locally installed Ollama models
          const res = await fetch("http://localhost:11434/api/tags");
          if (res.ok) {
            const data = await res.json();
            const models = (data.models || []).map((m: any) => m.name as string);
            if (!cancelled) setAvailableModels(models.length > 0 ? models : ["qwen3.5:latest"]);
          }
        } else if (currentProvider === "lmstudio") {
          // Fetch LM Studio models
          const res = await fetch("http://localhost:1234/v1/models");
          if (res.ok) {
            const data = await res.json();
            const models = (data.data || []).map((m: any) => m.id as string);
            if (!cancelled) setAvailableModels(models.length > 0 ? models : []);
          }
        } else if (currentProvider === "openrouter-free") {
          // Fetch free models from OpenRouter API
          const apiKey = process.env.OPENROUTER_API_KEY || "";
          const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });
          if (res.ok) {
            const data = await res.json();
            const freeModels = (data.data || [])
              .filter((m: any) => m.id?.endsWith(":free"))
              .map((m: any) => m.id as string)
              .sort();
            if (!cancelled) setAvailableModels(freeModels.length > 0 ? freeModels : ["google/gemini-2.5-flash:free"]);
          }
        } else if (currentProvider === "openrouter") {
          // Fetch all OpenRouter models (top 20 by context length)
          const apiKey = process.env.OPENROUTER_API_KEY || "";
          const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });
          if (res.ok) {
            const data = await res.json();
            const models = (data.data || [])
              .filter((m: any) => !m.id?.endsWith(":free"))
              .map((m: any) => m.id as string)
              .slice(0, 30);
            if (!cancelled) setAvailableModels(models);
          }
        } else {
          // Other providers — show placeholder
          if (!cancelled) setAvailableModels([`${currentProvider}/default`]);
        }
      } catch {
        // Provider not reachable — show fallback
        if (!cancelled) setAvailableModels(currentProvider === "ollama"
          ? ["qwen3.5:latest", "devstral:latest"]
          : ["google/gemini-2.5-flash:free"]);
      }
      if (!cancelled) setModelsLoading(false);
    };
    fetchModels();
    return () => { cancelled = true; };
  }, [currentProvider]);
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

  // Evidence tracking (real-time display)
  const [evidenceSummary, setEvidenceSummary] = useState<AgentEvidenceSummaryEvent | null>(null);

  // Check for updates on launch (non-blocking)
  const updateInfo = useUpdateCheck();

  // TV Mode state — task cards + narrator
  const viewport = useViewport();
  const [tvTasks, setTvTasks] = useState<TaskItem[]>([]);
  const [narratorText, setNarratorText] = useState("");

  // Image attachment (paste image paths or drag-drop)
  const imageInput = useImageInput({});

  // Background process panel
  const processPanel = useProcessPanel();

  // Message queue — user can type while agent is working
  const messageQueueRef = useRef<string[]>([]);
  const agentRunningRef = useRef(false);

  // Multi-agent orchestration
  const orchestration = useAgentOrchestration();

  // Onboarding system
  const [onboardingManager] = useState(() => new OnboardingManager(process.cwd()));
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentOnboardingQuestion, setCurrentOnboardingQuestion] = useState<string | null>(null);

  // Animation showcase
  const [currentAnimation, setCurrentAnimation] = useState<AnimationType>("all");

  // Agent mode (Tab to cycle)
  const [agentMode, setAgentMode] = useState<AgentMode>("Planning");

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
      flushSession();
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

    // Toggle kanban with Ctrl+K (overlay, not a tab)
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

    // Ctrl+T: new chat tab
    if (key.ctrl && input === "t") {
      workspaceTabs.addTab("chat");
      setViewMode("chat");
    }

    // Ctrl+W: close current tab
    if (key.ctrl && input === "w") {
      if (workspaceTabs.tabs.length > 1) {
        workspaceTabs.removeTab(workspaceTabs.activeTab.id);
      }
    }

    // Ctrl+1-9: switch to tab by index
    if (key.ctrl && input >= "1" && input <= "9") {
      const idx = parseInt(input, 10) - 1;
      if (idx < workspaceTabs.tabs.length) {
        workspaceTabs.switchToIndex(idx);
        // Only set viewMode for legacy views (kanban, music have their own)
        const tab = workspaceTabs.tabs[idx];
        if (tab?.type === "kanban") setViewMode("kanban");
        else if (tab?.type === "music") setViewMode("music");
        else setViewMode("chat");
      }
    }

    // Shift+Tab: cycle through open tabs
    if (key.shift && key.tab) {
      if (orchestration.agents.length > 0) {
        orchestration.cycleAgent();
      } else {
        workspaceTabs.cycleTab(1, ["kanban"]);
        setViewMode("chat");
      }
    }

    // Escape: abort generation if processing, otherwise switch to chat tab or close view
    if (key.escape) {
      if (isProcessing && agent) {
        agent.abort();
        setIsProcessing(false);
        setActiveTool(null);
        agentRunningRef.current = false;
        addSystemMessage("Generation interrupted.");
      } else if (activeTabType !== "chat" && viewMode === "chat") {
        // In a non-chat tab, escape switches back to first chat tab
        const chatTab = workspaceTabs.tabs.find(t => t.type === "chat");
        if (chatTab) workspaceTabs.switchTab(chatTab.id);
      } else if (viewMode !== "chat") {
        setViewMode("chat");
      }
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
              pushActivity(event.toolName, event.toolCallId, event.args);
              // Session logger
              const _tab = workspaceTabs.activeTab;
              logToolStart(_tab?.id || "default", _tab?.title || "Chat", event.toolName, event.toolCallId, event.args);

              // Auto-kanban: track real tool execution
              const activeTab = workspaceTabs.activeTab;
              autoKanban.onTaskStart(
                activeTab?.id || "default",
                activeTab?.title || "Chat",
                event.toolName,
                event.toolCallId,
                event.args,
              );

              // Auto-advance kanban: move first Ready card to In Progress
              setKanbanBoard((prev) => {
                if (prev.inProgress.length === 0 && prev.ready.length > 0) {
                  const [next, ...rest] = prev.ready;
                  return { ...prev, ready: rest, inProgress: [next] };
                }
                return prev;
              });
              // TV Mode: narrator + task card
              const narration = narrateToolStart(event.toolName, event.args);
              setNarratorText(narration);
              setTvTasks((prev) => [
                ...prev.map(t => t.status === "active" ? { ...t, status: "done" as const } : t),
                { id: event.toolCallId, title: narration, status: "active" as const },
              ]);

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
              completeActivity(event.toolCallId, event.success !== false, event.durationMs || 0);
              // Session logger
              logToolEnd(event.toolCallId, event.success !== false, event.durationMs || 0, event.resultPreview);

              // Auto-kanban: mark tool complete
              autoKanban.onTaskComplete(event.toolCallId, event.success !== false, event.durationMs || 0);

              // TV Mode: mark task done/error + update narrator
              const isFailure = !event.success || (event.resultPreview?.startsWith("Exit code ") && !event.resultPreview.startsWith("Exit code 0"));
              setNarratorText(narrateToolEnd(event.toolName, !isFailure, event.durationMs));
              setTvTasks((prev) => prev.map(t =>
                t.id === event.toolCallId
                  ? { ...t, status: isFailure ? "error" as const : "done" as const, duration: event.durationMs, details: isFailure ? event.resultPreview?.slice(0, 120) : undefined }
                  : t
              ));
              setActiveTool(null);

              // Auto-advance kanban: move first Ready → Done on each tool completion
              setKanbanBoard((prev) => {
                if (prev.inProgress.length > 0) {
                  // Move in-progress to done
                  const [completed, ...rest] = prev.inProgress;
                  const nextReady = prev.ready.length > 0 ? [prev.ready[0]] : [];
                  const remainingReady = prev.ready.slice(nextReady.length > 0 ? 1 : 0);
                  // Pull next from backlog if ready is getting empty
                  const pullFromBacklog = remainingReady.length < 2 && prev.backlog.length > 0
                    ? [prev.backlog[0]] : [];
                  const remainingBacklog = pullFromBacklog.length > 0 ? prev.backlog.slice(1) : prev.backlog;
                  return {
                    backlog: remainingBacklog,
                    ready: [...remainingReady, ...pullFromBacklog],
                    inProgress: [...rest, ...nextReady],
                    done: [...prev.done, completed],
                  };
                } else if (prev.ready.length > 0) {
                  // Move first ready to in-progress → done
                  const [first, ...rest] = prev.ready;
                  return { ...prev, ready: rest, done: [...prev.done, first] };
                }
                return prev;
              });
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
              // Session logger
              { const _tab = workspaceTabs.activeTab; logStep(_tab?.id || "default", _tab?.title || "Chat", event.stepNumber, event.usage.totalTokens, event.text); }

              // TV Mode: narrate the step
              if (event.text && event.text.trim()) {
                const planMatch = event.text.match(/PLAN:\s/i);
                if (planMatch) {
                  setNarratorText(narratePlan(event.text));
                } else {
                  setNarratorText(narrateStep(event.text));
                }
              }

              // Stream assistant's intermediate reasoning into the message list
              // so the user can see what the agent is thinking between tool calls
              if (event.text && event.text.trim()) {
                setMessages((prev) => [...prev, {
                  id: `assistant-step-${event.stepNumber}-${Date.now()}`,
                  role: "assistant" as const,
                  content: event.text,
                  timestamp: new Date(),
                }]);

                // Parse PLAN: output and populate kanban automatically
                const planMatch = event.text.match(/PLAN:\s*([\s\S]*?)(?:\n\n|$)/i);
                if (planMatch) {
                  const planText = planMatch[1];
                  // Match numbered steps: "1) ...", "1. ...", "- ..."
                  const stepMatches = planText.match(/(?:\d+[.)]\s*|[-•]\s+)([^\n]+)/g);
                  if (stepMatches && stepMatches.length > 0) {
                    const steps = stepMatches.map((s, i) => ({
                      id: `plan-${Date.now()}-${i}`,
                      description: s.replace(/^\d+[.)]\s*|^[-•]\s+/, "").trim(),
                      tool: "auto",
                      input: {},
                      priority: stepMatches.length - i,
                      confidence: 0.9,
                      category: "plan" as const,
                      predictedAt: new Date(),
                      basedOn: [],
                    }));
                    setKanbanBoard({
                      backlog: steps.slice(3) as any,
                      ready: steps.slice(0, 3) as any,
                      inProgress: [],
                      done: [],
                    });
                    setPredictedSteps(steps);
                    setPlanNextStep(steps[0]?.description || null);
                    setProcessingStage("executing");
                  }
                }
              }

              // Determine stage from step content
              if (event.toolCalls.length > 0) {
                setProcessingStage("executing");
                setStatus("executing");
              } else {
                setProcessingStage("toolshed");
                setStatus("thinking");
              }
            },
            onEvidence: (event: AgentEvidenceEvent) => {
              // Show evidence collection in real-time as compact tool messages
              const icon = event.verified ? "\u2713" : "\u2717";
              const label = event.type.replace(/_/g, " ");
              // Shorten description: use basename for paths, truncate commands
              let desc = event.description;
              if (event.path) {
                const basename = event.path.split("/").pop() || event.path;
                desc = basename;
              } else if (event.command) {
                desc = event.command.slice(0, 40);
              }
              setMessages((prev) => [...prev, {
                id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: "tool" as const,
                content: `  ${icon} ${label}: ${desc}`,
                timestamp: new Date(),
                toolSuccess: event.verified,
              }]);
            },
            onEvidenceSummary: (event: AgentEvidenceSummaryEvent) => {
              setEvidenceSummary(event);
              // Show one-line summary at end of response
              if (event.total > 0) {
                setMessages((prev) => [...prev, {
                  id: `evidence-summary-${Date.now()}`,
                  role: "system" as const,
                  content: `[Evidence: ${event.verified}/${event.total} verified]`,
                  timestamp: new Date(),
                  toolSuccess: event.failed === 0,
                }]);
              }
            },
          },
        });
        // Check if provider is available
        const ready = await newAgent.isReady();
        if (ready) {
          setAgent(newAgent);
          setAgentReady(true);

          // Check for personal LoRA
          try {
            const loraDir = require("path").join(require("os").homedir(), ".8gent", "personal-lora");
            const configPath = require("path").join(require("os").homedir(), ".8gent", "config.json");
            const fs = require("fs");
            if (fs.existsSync(loraDir) && fs.existsSync(configPath)) {
              const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
              if (cfg.personal?.autoRetrain !== false) {
                setMessages((prev) => [...prev, {
                  id: `personal-lora-${Date.now()}`,
                  role: "system" as const,
                  content: `Personal LoRA detected. Loaded on top of ${currentModel}.`,
                  timestamp: new Date(),
                }]);
              }
            }
          } catch {}
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
      // Auto-detect environment (git config, ollama models, gh auth)
      const detected = await OnboardingManager.autoDetect();
      onboardingManager.applyAutoDetected(detected);

      // Also detect integrations (LM Studio, etc.)
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

  // Handle /vision command — manage vision & OCR model settings
  const handleVisionCommand = useCallback(async (args: string[]) => {
    const { loadVisionConfig, saveVisionConfig, findVisionModel, findOCRModel, getRecommendedOCRModels } = await import("../../../packages/eight/vision-router.js");
    const config = loadVisionConfig();

    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "status") {
      // Show current vision config and available models
      const visionResult = await findVisionModel({ taskType: "general", config });
      const ocrResult = await findOCRModel();
      const available = visionResult.allAvailable;
      const ocrAvailable = ocrResult.allAvailable.filter((m: any) => m.ocrSpecialized);

      addSystemMessage(
        `Vision Settings:\n` +
        `  Enabled: ${config.enabled ? "yes" : "no"}\n` +
        `  Provider: ${config.provider}\n` +
        `  Default model: ${config.defaultModel}\n` +
        `  OCR model: ${config.ocrModel}\n` +
        `  Prefer local: ${config.preferLocal ? "yes" : "no"}\n` +
        `  Timeout: ${config.timeout}ms\n\n` +
        `Active Vision: ${visionResult.model?.displayName || "none"}\n` +
        `Active OCR: ${ocrResult.model?.displayName || "none"}\n\n` +
        `Available vision models (${available.length}):\n` +
        (available.length > 0
          ? available.map((m: any) => `  ${m.ocrSpecialized ? "[OCR]" : "[VIS]"} ${m.displayName} ${m.free ? "(free)" : ""}`).join("\n")
          : "  None found locally. Try: ollama pull qwen2.5-vl") +
        `\n\nCommands:\n` +
        `  /vision model <name>   — Set default vision model\n` +
        `  /vision ocr <name>     — Set OCR model (or "auto")\n` +
        `  /vision on|off         — Enable/disable vision\n` +
        `  /vision pull           — Show recommended models to pull`
      );
    } else if (sub === "model" && args[1]) {
      const model = args.slice(1).join(" ");
      saveVisionConfig({ defaultModel: model });
      addSystemMessage(`Vision model set to: ${model}\nThis will be used for image description tasks.`);
    } else if (sub === "ocr" && args[1]) {
      const model = args.slice(1).join(" ");
      saveVisionConfig({ ocrModel: model });
      addSystemMessage(`OCR model set to: ${model}\n${model === "auto" ? "Will auto-discover the best OCR model." : "This will be used for text extraction tasks."}`);
    } else if (sub === "on" || sub === "enable") {
      saveVisionConfig({ enabled: true });
      addSystemMessage("Vision enabled.");
    } else if (sub === "off" || sub === "disable") {
      saveVisionConfig({ enabled: false });
      addSystemMessage("Vision disabled. Images will not be interpreted.");
    } else if (sub === "local") {
      saveVisionConfig({ preferLocal: true, provider: "ollama" });
      addSystemMessage("Vision set to local-only (Ollama). Free and private.");
    } else if (sub === "cloud" || sub === "openrouter") {
      saveVisionConfig({ preferLocal: false, provider: "openrouter" });
      addSystemMessage("Vision set to cloud (OpenRouter). Includes free models.");
    } else if (sub === "pull") {
      const recommended = getRecommendedOCRModels();
      addSystemMessage(
        "Recommended vision/OCR models to pull:\n\n" +
        recommended.map((m: any) => `  ollama pull ${m.model}  — ${m.description} (${m.size})`).join("\n") +
        "\n\nGeneral vision (default):\n" +
        "  ollama pull qwen2.5-vl     — Best general vision + OCR (~5GB)\n" +
        "  ollama pull minicpm-v       — Mobile-friendly (~5GB)\n" +
        "  ollama pull llava           — Classic, widely supported (~4GB)\n" +
        "  ollama pull moondream       — Tiny and fast (~1.7GB)"
      );
    } else {
      addSystemMessage(
        `Unknown vision subcommand: "${sub}"\n` +
        "Usage: /vision [status|model|ocr|on|off|local|cloud|pull]"
      );
    }
  }, [addSystemMessage]);

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
              "  /evidence - Show full evidence breakdown\n" +
              "  /notes - Open scratchpad notes tab\n" +
              "  /ideas - Open idea capture tab\n" +
              "  /btw - Open sidequest queue tab\n" +
              "  /questions - Open research questions tab\n" +
              "  /projects - Open project overview tab\n" +
              "  /auth [login|logout|status] - Authentication\n" +
              "  /github [issues|pr|repos] - GitHub integration\n" +
              "  /voice record - Toggle voice input (Ctrl+R)\n" +
              "  /vision - Vision & OCR model settings\n" +
              "  /plan - Show current plan status\n" +
              "  /status - Show session status\n" +
              "  /clear - Clear messages\n" +
              "  /quit - Exit 8gent Code\n\n" +
              "Keyboard shortcuts:\n" +
              "  Tab - Accept ghost suggestion\n" +
              "  Ctrl+T - New chat tab\n" +
              "  Ctrl+W - Close current tab\n" +
              "  Ctrl+1-9 - Switch to tab by number\n" +
              "  Shift+Tab - Cycle through tabs\n" +
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
          if (autoKanban.stats.total > 0) {
            addSystemMessage(
              `Task board (auto):\n` +
                `  Backlog: ${autoKanban.columns.backlog.length}\n` +
                `  Ready: ${autoKanban.columns.ready.length}\n` +
                `  In Progress: ${autoKanban.columns.inProgress.length}\n` +
                `  Done: ${autoKanban.stats.done} | Failed: ${autoKanban.stats.failed}\n` +
                `  Total: ${autoKanban.stats.total} tasks`
            );
          } else {
            addSystemMessage(
              `Current plan status:\n` +
                `  Backlog: ${kanbanBoard.backlog.length} items\n` +
                `  Ready: ${kanbanBoard.ready.length} items\n` +
                `  In Progress: ${kanbanBoard.inProgress.length} items\n` +
                `  Done: ${kanbanBoard.done.length} items`
            );
          }
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
          flushSession();
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

        case "history":
          // Show history screen
          if (!agent) {
            addSystemMessage("No agent active — start a session first.");
            break;
          }
          agent.getSessionSync().getRecentConversations(20).then((convos) => {
            if (convos.length === 0) {
              addSystemMessage("No previous sessions found.");
            } else {
              addSystemMessage(
                `Found ${convos.length} sessions. Use /resume to pick one or /continue to restore the latest.`
              );
            }
          }).catch(() => {
            addSystemMessage("Could not load session history.");
          });
          break;

        case "continue":
          // Continue most recent session
          if (!agent) {
            addSystemMessage("No agent active — start a session first.");
            break;
          }
          agent.getSessionSync().getRecentConversations(1).then((convos) => {
            if (convos.length === 0 || !convos[0].checkpointData) {
              addSystemMessage("No session to continue. Start chatting to create history.");
            } else {
              try {
                const messages = JSON.parse(convos[0].checkpointData);
                agent.restoreFromCheckpoint(messages);
                addSystemMessage(
                  `Restored session: "${convos[0].title}"\n` +
                  `  ${convos[0].messageCount} messages - ${convos[0].model}\n` +
                  `  Last active: ${new Date(convos[0].lastActiveAt).toLocaleString()}\n\n` +
                  "Context restored. Continue where you left off."
                );
              } catch {
                addSystemMessage("Failed to parse checkpoint data.");
              }
            }
          }).catch(() => {
            addSystemMessage("Could not load session history.");
          });
          break;

        case "resume":
          // Show last 5 sessions to pick from
          if (!agent) {
            addSystemMessage("No agent active — start a session first.");
            break;
          }
          agent.getSessionSync().getRecentConversations(5).then((convos) => {
            if (convos.length === 0) {
              addSystemMessage("No previous sessions found.");
            } else {
              const lines = ["Recent sessions (reply with number to resume):\n"];
              convos.forEach((c: any, i: number) => {
                const ago = Math.floor((Date.now() - c.lastActiveAt) / 60000);
                const timeStr = ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
                lines.push(`  ${i + 1}. ${c.title.slice(0, 50)} — ${c.model} - ${c.messageCount} msgs - ${timeStr}`);
              });
              addSystemMessage(lines.join("\n"));
            }
          }).catch(() => {
            addSystemMessage("Could not load session history.");
          });
          break;

        case "compact":
          // Summarize current conversation
          if (!agent) {
            addSystemMessage("No agent active.");
            break;
          }
          addSystemMessage("Compacting conversation history...");
          {
            const history = agent.getMessageHistory();
            const userMsgs = history.filter(m => m.role === "user").length;
            const assistantMsgs = history.filter(m => m.role === "assistant").length;
            // Keep system prompt + last 4 messages
            if (history.length > 5) {
              const systemMsg = history[0];
              const recentMsgs = history.slice(-4);
              agent.restoreFromCheckpoint([systemMsg, ...recentMsgs]);
              addSystemMessage(
                `Compacted: ${userMsgs} user + ${assistantMsgs} assistant messages -> kept last 4.\n` +
                "Context trimmed. Older messages removed from active memory."
              );
            } else {
              addSystemMessage("Conversation too short to compact.");
            }
          }
          break;

        case "chat":
          if (orchestration.chatMode) {
            orchestration.exitChatMode();
            addSystemMessage("Chat mode disabled. Returning to normal mode.");
          } else {
            orchestration.enterChatMode();
            addSystemMessage(
              "Chat mode enabled. Background work continues.\n" +
              "Shift+Tab to cycle agents. ESC to exit chat mode.\n" +
              `Currently addressing: ${orchestration.activeAgentName}`
            );
          }
          break;

        case "agent":
          const agentSub = args[0] || "list";
          if (agentSub === "list") {
            if (orchestration.agents.length === 0) {
              addSystemMessage("No active sub-agents. Eight is operating solo.\n\nUse /agent spawn <persona> <task> to spawn one.");
            } else {
              const lines = orchestration.agents.map(a =>
                `  ${a.icon} ${a.name} (${a.role}) — ${a.status}\n    Task: ${a.task}`
              );
              addSystemMessage(`Active agents (${orchestration.agents.length + 1}):\n\n  Eight (orchestrator) — running\n${lines.join("\n")}`);
            }
          } else if (agentSub === "spawn") {
            const personaId = args[1];
            const task = args.slice(2).join(" ");
            if (!personaId) {
              addSystemMessage("Usage: /agent spawn <persona> <task>\n\nPersonas: winston, larry, curly, mo, doc");
            } else {
              orchestration.spawnAgent(personaId, task || "General assistance");
              addSystemMessage(`Spawn request submitted for ${personaId}...`);
            }
          } else if (agentSub === "kill") {
            const killId = args[1];
            if (!killId) {
              addSystemMessage("Usage: /agent kill <agent-id>\n\nUse /agent list to see active agents.");
            } else {
              const found = orchestration.agents.find(a => a.id.includes(killId) || a.name.toLowerCase() === killId.toLowerCase());
              if (found) {
                orchestration.killAgent(found.id);
                addSystemMessage(`Killed agent: ${found.name} (${found.role})`);
              } else {
                addSystemMessage(`Agent "${killId}" not found.`);
              }
            }
          } else if (agentSub === "auto") {
            orchestration.toggleAutoSpawn();
            addSystemMessage(`Auto-spawn: ${!orchestration.autoSpawn ? "ENABLED" : "DISABLED"}\n${!orchestration.autoSpawn ? "Eight will automatically spawn sub-agents without asking." : "Eight will ask before spawning sub-agents."}`);
          } else if (agentSub === "settings") {
            addSystemMessage(
              "Agent Settings:\n\n" +
              `  Auto-spawn: ${orchestration.autoSpawn ? "on" : "off"}\n` +
              `  Active agents: ${orchestration.agents.length}\n` +
              `  Pending spawns: ${orchestration.pendingSpawns.length}\n\n` +
              "Commands:\n" +
              "  /agent list       — Show active agents\n" +
              "  /agent spawn <p>  — Spawn persona (winston/larry/curly/mo/doc)\n" +
              "  /agent kill <id>  — Kill an agent\n" +
              "  /agent auto       — Toggle auto-spawn"
            );
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

        case "adhd": {
          // ADHD mode — focus toolkit
          const adhdAudio = getADHDAudio();
          const sub = args[0]?.toLowerCase();

          if (!sub) {
            // Toggle text mode
            const newMode = !adhdMode;
            setAdhdMode(newMode);
            addSystemMessage(newMode ? ADHD_MODE_ENABLED_MSG : ADHD_MODE_DISABLED_MSG);
            break;
          }

          // Text mode toggles
          if (sub === "on" || sub === "enable" || sub === "true") {
            setAdhdMode(true);
            addSystemMessage(ADHD_MODE_ENABLED_MSG);
          } else if (sub === "off" || sub === "disable" || sub === "false") {
            setAdhdMode(false);
            adhdAudio.stop();
            addSystemMessage(ADHD_MODE_DISABLED_MSG);
          }
          // Audio controls
          else if (sub === "stop" || sub === "pause") {
            adhdAudio.stop();
            addSystemMessage("Audio paused. Text mode still " + (adhdMode ? "on" : "off") + ". Play again with /adhd lofi etc.");
          }
          // Config: /adhd config, /adhd set <key> <value>
          else if (sub === "config" || sub === "settings") {
            const cfg = adhdAudio.config;
            addSystemMessage(
              "ADHD Audio Config\n\n" +
              `  duration:       ${cfg.duration}s\n` +
              `  bpm:            ${cfg.bpm ?? "auto (per preset)"}\n` +
              `  inferenceSteps: ${cfg.inferenceSteps}\n` +
              `  guidanceScale:  ${cfg.guidanceScale}\n` +
              `  batchSize:      ${cfg.batchSize}\n` +
              `  apiUrl:         ${cfg.apiUrl}\n\n` +
              "Set with: /adhd set <key> <value>\n" +
              "Example:  /adhd set duration 120"
            );
          }
          else if (sub === "set" && args.length >= 3) {
            const key = args[1].toLowerCase();
            const val = args[2];
            const validKeys: Record<string, string> = {
              duration: "duration", length: "duration", time: "duration",
              bpm: "bpm", tempo: "bpm",
              steps: "inferenceSteps", inferencesteps: "inferenceSteps", quality: "inferenceSteps",
              guidance: "guidanceScale", guidancescale: "guidanceScale",
              batch: "batchSize", batchsize: "batchSize",
              api: "apiUrl", apiurl: "apiUrl", url: "apiUrl",
            };
            const configKey = validKeys[key];
            if (!configKey) {
              addSystemMessage(`Unknown config key "${key}". Valid: ${Object.keys(validKeys).join(", ")}`);
            } else if (configKey === "apiUrl") {
              const updated = adhdAudio.setConfig({ apiUrl: val });
              addSystemMessage(`apiUrl set to ${updated.apiUrl}`);
            } else {
              const numVal = Number(val);
              if (isNaN(numVal)) {
                addSystemMessage(`"${val}" isn't a number.`);
              } else if (configKey === "bpm" && val === "auto") {
                adhdAudio.setConfig({ bpm: null });
                addSystemMessage("bpm set to auto (uses preset default).");
              } else {
                const updated = adhdAudio.setConfig({ [configKey]: numVal } as any);
                addSystemMessage(`${configKey} set to ${(updated as any)[configKey]}. Cached audio cleared.`);
              }
            }
          }
          // Clear cache
          else if (sub === "clear" || sub === "regenerate" || sub === "regen") {
            adhdAudio.clearCache();
            addSystemMessage("Audio cache cleared. Next play will regenerate fresh tracks.");
          }
          // Soundscapes: lofi, rainsound, whitenoise, ambient, classical
          else if (["lofi", "rainsound", "whitenoise", "ambient", "classical"].includes(sub)) {
            if (!adhdMode) {
              setAdhdMode(true);
              addSystemMessage(ADHD_MODE_ENABLED_MSG);
            }
            addSystemMessage(`Loading ${sub}...`);
            adhdAudio.play(sub as ADHDSoundscape).then((result) => {
              addSystemMessage(result.message);
            });
          }
          else {
            const cfg = adhdAudio.config;
            addSystemMessage(
              "ADHD Mode — your focus toolkit\n\n" +
              "  /adhd              Toggle text mode\n" +
              "  /adhd on|off       Enable/disable\n\n" +
              "  Audio:\n" +
              "  /adhd lofi         Lofi beats\n" +
              "  /adhd rainsound    Rain sounds\n" +
              "  /adhd whitenoise   White noise\n" +
              "  /adhd ambient      Ambient synths\n" +
              "  /adhd classical    Soft piano\n" +
              "  /adhd stop         Stop audio\n\n" +
              "  Config:\n" +
              "  /adhd config       Show current settings\n" +
              "  /adhd set <k> <v>  Change a setting\n" +
              "  /adhd regen        Clear cache & regenerate\n\n" +
              `Status: text=${adhdMode ? "on" : "off"} · audio=${adhdAudio.isPlaying ? adhdAudio.current : "off"} · duration=${cfg.duration}s`
            );
          }
          break;
        }

        case "router": {
          const router = getTaskRouter();
          const sub = args[0]?.toLowerCase();

          if (!sub || sub === "status") {
            const cfg = router.getConfig();
            const lines = [
              `Task Router — ${cfg.enabled ? "enabled" : "disabled"}`,
              "",
              "Slot Assignments:",
              `  code:      ${cfg.slots.code.model} (${cfg.slots.code.provider})`,
              `  reasoning: ${cfg.slots.reasoning.model} (${cfg.slots.reasoning.provider})`,
              `  simple:    ${cfg.slots.simple.model} (${cfg.slots.simple.provider})`,
              `  creative:  ${cfg.slots.creative.model} (${cfg.slots.creative.provider})`,
              "",
              `  classifier: ${cfg.classifierModel}`,
              `  threshold:  ${cfg.confidenceThreshold}`,
              `  default:    ${cfg.defaultModel.model}`,
              "",
              "Commands:",
              "  /router on|off           Enable/disable routing",
              "  /router set <cat> <model> Assign model to category",
              "  /router test <prompt>     Test classification",
              "  /router stats             Show routing stats",
              "  /router auto              Auto-assign from Ollama models",
            ];
            addSystemMessage(lines.join("\n"));
          } else if (sub === "on" || sub === "enable") {
            router.setConfig({ enabled: true });
            addSystemMessage("Task router enabled. Messages will be classified and routed.");
          } else if (sub === "off" || sub === "disable") {
            router.setConfig({ enabled: false });
            addSystemMessage("Task router disabled. All messages go to default model.");
          } else if (sub === "set" && args.length >= 3) {
            const cat = args[1].toLowerCase() as TaskCategory;
            const model = args.slice(2).join(" ");
            if (!["code", "reasoning", "simple", "creative"].includes(cat)) {
              addSystemMessage(`Unknown category "${cat}". Use: code, reasoning, simple, creative`);
            } else {
              router.setSlot(cat, { model, provider: currentProvider as any || "ollama" });
              addSystemMessage(`${cat} → ${model}`);
            }
          } else if (sub === "test" && args.length >= 2) {
            const testPrompt = args.slice(1).join(" ");
            addSystemMessage(`Classifying: "${testPrompt}"...`);
            router.route(testPrompt).then((decision) => {
              addSystemMessage(
                `Category: ${decision.category} (${(decision.confidence * 100).toFixed(0)}%)\n` +
                `Model: ${decision.model}\n` +
                `Reasoning: ${decision.reasoning}`
              );
            }).catch((err) => {
              addSystemMessage(`Classification failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else if (sub === "stats") {
            const stats = getRouterStats();
            const lines = [
              `Router Stats (${stats.totalRouted} total routes)`,
              "",
              "By Category:",
              ...Object.entries(stats.byCategory).map(([k, v]) => `  ${k}: ${v}`),
              "",
              "By Model:",
              ...Object.entries(stats.byModel).map(([k, v]) =>
                `  ${k}: ${v.routed} routes, avg ${Math.round(v.avgLatencyMs)}ms`
              ),
            ];
            addSystemMessage(lines.join("\n"));
          } else if (sub === "classifier" && args.length >= 2) {
            router.setConfig({ classifierModel: args.slice(1).join(" ") });
            addSystemMessage(`Classifier model set to ${args.slice(1).join(" ")}`);
          } else if (sub === "threshold" && args[1]) {
            const val = parseFloat(args[1]);
            if (!isNaN(val)) {
              router.setConfig({ confidenceThreshold: Math.max(0, Math.min(1, val)) });
              addSystemMessage(`Confidence threshold set to ${val}`);
            }
          } else if (sub === "auto") {
            addSystemMessage("Scanning Ollama models...");
            router.autoAssign().then((changes) => {
              if (changes.length === 0) {
                addSystemMessage("No changes — slots already optimal.");
              } else {
                addSystemMessage("Auto-assigned:\n" + changes.map(c => `  ${c}`).join("\n"));
              }
            });
          } else {
            addSystemMessage("Unknown router command. Try /router for help.");
          }
          break;
        }

        case "rename": {
          // Rename current tab: /rename New Name
          const newName = args.join(" ").trim();
          if (!newName) {
            addSystemMessage("Usage: /rename My New Tab Name");
          } else if (workspaceTabs.activeTab) {
            workspaceTabs.renameTab(workspaceTabs.activeTab.id, newName);
            addSystemMessage(`Tab renamed to "${newName}"`);
          }
          break;
        }

        case "debug": {
          // Debug CLI inside TUI — runs bin/debug.ts and shows output
          const debugCmd = args.length > 0 ? args.join(" ") : "sessions";
          const debugScript = require("path").join(process.cwd(), "bin", "debug.ts");
          try {
            const result = Bun.spawnSync(["bun", "run", debugScript, ...debugCmd.split(" ")], {
              cwd: process.cwd(),
              env: { ...process.env, NO_COLOR: "1" }, // strip ANSI for clean display
              timeout: 10000,
            });
            const output = result.stdout?.toString()?.trim() || "No output";
            const stderr = result.stderr?.toString()?.trim();
            if (stderr && result.exitCode !== 0) {
              addSystemMessage(`Debug error: ${stderr.slice(0, 200)}`);
            } else {
              addSystemMessage(output.slice(0, 2000));
            }
          } catch (err) {
            addSystemMessage(`Debug failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case "music": {
          // Interactive music generation via ACE-Step
          const musicAudio = getADHDAudio();
          const musicSub = args[0]?.toLowerCase();

          if (!musicSub) {
            // Open music as a persistent tab
            workspaceTabs.addTab("music");
          }
          // Quick play aliases
          else if (["lofi", "rain", "rainsound", "white", "whitenoise", "ambient", "piano", "classical"].includes(musicSub)) {
            const keyMap: Record<string, string> = { rain: "rainsound", white: "whitenoise", piano: "classical" };
            const key = keyMap[musicSub] || musicSub;
            musicAudio.onProgress = (msg) => addSystemMessage(msg);
            musicAudio.play(key as any).then(r => { addSystemMessage(r.message); musicAudio.onProgress = null; });
          }
          // Custom prompt generation
          else if (musicSub === "gen" && args.length >= 2) {
            const customPrompt = args.slice(1).join(" ");
            const cfg = musicAudio.config;
            addSystemMessage(`🎵 Generating "${customPrompt}" (${cfg.duration}s)...`);

            // Use ACE-Step API directly for custom prompts
            fetch(`${cfg.apiUrl}/release_task`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt: customPrompt + ", instrumental",
                lyrics: "[instrumental]",
                audio_duration: cfg.duration,
                bpm: cfg.bpm || null,
                inference_steps: cfg.inferenceSteps,
                guidance_scale: cfg.guidanceScale,
                use_random_seed: true,
                task_type: "text2music",
                thinking: false,
                use_cot_caption: false,
                use_cot_language: false,
                batch_size: 1,
              }),
            })
              .then(r => r.json())
              .then((data: any) => {
                const taskId = data?.data?.task_id;
                if (!taskId) {
                  addSystemMessage("Failed to start generation. Is ACE-Step running?");
                  return;
                }
                addSystemMessage(`🎵 Generating... (task ${taskId.slice(0, 8)})`);

                // Poll for result with progress updates
                const poll = async () => {
                  const maxWait = 300000;
                  const start = Date.now();
                  let lastUpdate = 0;
                  while (Date.now() - start < maxWait) {
                    const elapsed = Math.round((Date.now() - start) / 1000);

                    // Progress update every 10s
                    if (elapsed - lastUpdate >= 10) {
                      lastUpdate = elapsed;
                      addSystemMessage(`🎵 Still generating... ${elapsed}s elapsed`);
                    }

                    try {
                      const res = await fetch(`${cfg.apiUrl}/query_result`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ task_id_list: [taskId] }),
                      });
                      const result: any = await res.json();
                      const job = result?.data?.[0];
                      if (job?.status === 1) {
                        const results = JSON.parse(job.result);
                        const audioUrl = results?.[0]?.file;
                        if (audioUrl) {
                          // Download and play
                          const fullUrl = audioUrl.startsWith("http") ? audioUrl : `${cfg.apiUrl}${audioUrl}`;
                          const audioRes = await fetch(fullUrl);
                          const buf = await audioRes.arrayBuffer();
                          const { join } = await import("path");
                          const cachePath = join(process.env.HOME || "~", ".8gent", "adhd-audio", "custom.mp3");
                          await Bun.write(cachePath, buf);
                          addSystemMessage(`Track ready! Playing on loop. /music stop to end.`);
                          // Play via afplay loop
                          const { spawn } = await import("bun");
                          const loopPlay = () => {
                            const proc = spawn(["afplay", cachePath], {
                              stdout: "ignore", stderr: "ignore",
                              onExit: () => { if (musicAudio.isPlaying) loopPlay(); },
                            });
                          };
                          loopPlay();
                          return;
                        }
                      }
                      if (job?.status === 2) {
                        addSystemMessage("Generation failed. Try a different prompt.");
                        return;
                      }
                    } catch {}
                    await Bun.sleep(2000);
                  }
                  addSystemMessage("Generation timed out (5 min). Try shorter duration: /music set duration 60");
                };
                poll();
              })
              .catch(() => {
                addSystemMessage("ACE-Step isn't running. Start it first:\n  cd ~/ace-step/ace-step-1.5 && uv run --frozen python -m uvicorn acestep.api_server:app --host 0.0.0.0 --port 8001 --workers 1");
              });
          }
          // Controls
          else if (musicSub === "stop" || musicSub === "pause") {
            musicAudio.stop();
            addSystemMessage("Music stopped.");
          }
          else if (musicSub === "player" || musicSub === "playlist" || musicSub === "view") {
            setViewMode("music");
          }
          else if (musicSub === "config" || musicSub === "settings") {
            const cfg = musicAudio.config;
            addSystemMessage(
              "Music Config\n\n" +
              `  duration:  ${cfg.duration}s (${Math.round(cfg.duration / 60)}min)\n` +
              `  bpm:       ${cfg.bpm ?? "auto"}\n` +
              `  quality:   ${cfg.inferenceSteps} steps\n` +
              `  guidance:  ${cfg.guidanceScale}\n` +
              `  api:       ${cfg.apiUrl}\n\n` +
              "Change with: /music set <key> <value>"
            );
          }
          else if (musicSub === "set" && args.length >= 3) {
            const key = args[1].toLowerCase();
            const val = args[2];
            const keyMap: Record<string, string> = {
              duration: "duration", length: "duration", time: "duration",
              bpm: "bpm", tempo: "bpm",
              steps: "inferenceSteps", quality: "inferenceSteps",
              guidance: "guidanceScale",
            };
            const configKey = keyMap[key];
            if (!configKey) {
              addSystemMessage(`Unknown key. Use: duration, bpm, steps, guidance`);
            } else {
              const numVal = Number(val);
              if (isNaN(numVal)) {
                addSystemMessage(`"${val}" isn't a number.`);
              } else {
                musicAudio.setConfig({ [configKey]: numVal } as any);
                addSystemMessage(`${configKey} set to ${numVal}. Cache cleared — next play regenerates.`);
              }
            }
          }
          else if (musicSub === "regen" || musicSub === "clear") {
            musicAudio.clearCache();
            addSystemMessage("Cache cleared. Next play will generate fresh tracks.");
          }
          else {
            addSystemMessage(`Unknown: /music ${musicSub}. Try /music for help.`);
          }
          break;
        }

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

        case "evidence":
          // Show full evidence breakdown
          if (!agent) {
            addSystemMessage("No agent active — evidence requires a running session.");
            break;
          }
          const evidence = agent.getSessionEvidence();
          if (evidence.length === 0) {
            addSystemMessage("No evidence collected yet.\nEvidence is gathered after write_file, edit_file, run_command, and git_commit.");
            break;
          }
          const evSummary = evidence.reduce((acc, ev) => {
            acc.total++;
            if (ev.verified) acc.verified++;
            else acc.failed++;
            acc.byType[ev.type] = (acc.byType[ev.type] || 0) + 1;
            return acc;
          }, { total: 0, verified: 0, failed: 0, byType: {} as Record<string, number> });
          const evLines = [
            `Evidence Breakdown (${evSummary.verified}/${evSummary.total} verified):`,
            "",
          ];
          for (const ev of evidence) {
            const icon = ev.verified ? "\u2713" : "\u2717";
            const label = `[${ev.type}]`.padEnd(18);
            evLines.push(`  ${icon} ${label} ${ev.description}`);
          }
          evLines.push("");
          evLines.push("By type:");
          for (const [type, count] of Object.entries(evSummary.byType)) {
            evLines.push(`  ${type}: ${count}`);
          }
          addSystemMessage(evLines.join("\n"));
          break;

        case "voice":
          // Enhanced voice command — toggle STT recording or voice chat
          if (args[0] === "chat" || args[0] === "conversation" || args[0] === "talk") {
            if (voiceChat.isActive) {
              voiceChat.stop();
            } else {
              voiceChat.start().catch((err: Error) => {
                addSystemMessage(`Voice chat error: ${err.message}`);
              });
            }
          } else if (args[0] === "record" || args[0] === "listen" || args[0] === "stt") {
            voice.toggle().catch((err: Error) => {
              addSystemMessage(`Voice error: ${err.message}`);
            });
            addSystemMessage(
              voice.state === "recording"
                ? "Voice recording stopped."
                : "Voice recording started. Speak now... (Ctrl+R to stop)"
            );
          } else if (args[0] === "status") {
            const setupInfo = voice.setupStatus;
            const voiceChatStatus = voiceChat.isActive
              ? `\nVoice Chat: Active (${voiceChat.state})`
              : "\nVoice Chat: Inactive";
            const status = voice.isAvailable
              ? `Voice: Available (model: ${voice.engine.getConfig().model || "base"})${voiceChatStatus}`
              : `Voice: Not available — ${setupInfo?.missing?.join(", ") || voice.errorMessage || "sox/whisper not found"}`;
            addSystemMessage(status);
          } else if (args[0] === "stop") {
            if (voiceChat.isActive) {
              voiceChat.stop();
            } else {
              addSystemMessage("Voice chat is not active.");
            }
          } else {
            addSystemMessage(
              "Voice commands:\n" +
              "  /voice chat    — Start/stop voice conversation mode\n" +
              "  /voice record  — Toggle STT recording (or press Ctrl+R)\n" +
              "  /voice status  — Check voice system status\n" +
              "  /voice stop    — Stop voice chat mode\n" +
              "  /voice on|off  — Toggle TTS output"
            );
          }
          break;

        // Model selection - check if args provided
        default:
          // Handle /auth command
          if ((command as string) === "auth") {
            const sub = args[0] || "status";
            if (sub === "login") {
              addSystemMessage("Opening browser to sign in...");
              import("../../../packages/auth/cli-auth-server.js").then(({ runCLIAuthFlow }) => {
                runCLIAuthFlow("https://8gent.world", {
                  onServerReady: () => {},
                  onBrowserOpened: () => {},
                  onWaiting: () => {},
                  onTokenReceived: (result) => {
                    if (result.success) {
                      setAuthStatus("authenticated");
                      setAuthUser({
                        displayName: result.displayName || "User",
                        plan: "free",
                      });
                      addSystemMessage(`Signed in as ${result.displayName || result.email || "User"}`);

                      // Set up GitHub integration silently (no messages)
                      import("../../../packages/auth/github.js").then(({ getGitHubAuth }) => {
                        const gh = getGitHubAuth();
                        if (result.token) {
                          gh.storeToken(result.token);
                          gh.configureGhCli(result.token).catch(() => {});
                        }
                        // Silently verify GitHub — no chat message
                        gh.getUser().catch(() => {});
                      }).catch(() => {});
                    }
                  },
                  onTimeout: () => {
                    addSystemMessage("Auth timed out. Try /auth login again.");
                  },
                  onError: (err) => {
                    addSystemMessage(`Auth error: ${err}`);
                  },
                }).catch(() => {
                  addSystemMessage("Auth failed. Running in anonymous mode.");
                });
              });
            } else if (sub === "logout") {
              authManager?.logout?.();
              setAuthStatus("anonymous");
              setAuthUser(null);
              addSystemMessage("Logged out. Running in anonymous mode.");
            } else if (sub === "github") {
              // Show GitHub-specific info
              import("../../../packages/auth/github.js").then(({ getGitHubAuth }) => {
                const gh = getGitHubAuth();
                Promise.all([
                  gh.getUser(),
                  gh.isGhCliAvailable(),
                  gh.getToken(),
                ]).then(([user, ghCliAvailable, token]) => {
                  import("../../../packages/auth/github-tools.js").then(({ getCurrentRepoInfo }) => {
                    getCurrentRepoInfo().then((repoInfo) => {
                      const lines = ["GitHub Integration:"];
                      lines.push(`  Connected: ${token ? "Yes" : "No"}`);
                      if (user) {
                        lines.push(`  Username: @${user.username}`);
                        lines.push(`  Name: ${user.name}`);
                        lines.push(`  Profile: ${user.profileUrl}`);
                      }
                      lines.push(`  gh CLI: ${ghCliAvailable ? "Available" : "Not found"}`);
                      if (repoInfo) {
                        lines.push(`  Current repo: ${repoInfo.owner}/${repoInfo.repo}`);
                      }
                      addSystemMessage(lines.join("\n"));
                    });
                  });
                }).catch(() => {
                  addSystemMessage("GitHub: Not connected. Run /auth login first.");
                });
              }).catch(() => {
                addSystemMessage("GitHub module not available.");
              });
            } else {
              // Show general auth status + GitHub summary
              import("../../../packages/auth/github.js").then(({ getGitHubAuth }) => {
                const gh = getGitHubAuth();
                gh.getUser().then((ghUser) => {
                  addSystemMessage(
                    `Auth Status: ${authStatus}\n` +
                    (authUser ? `User: ${authUser.displayName} (${authUser.plan})\n` : "") +
                    (ghUser ? `GitHub: @${ghUser.username}\n` : "") +
                    "\nCommands: /auth login, /auth logout, /auth github"
                  );
                }).catch(() => {
                  addSystemMessage(
                    `Auth Status: ${authStatus}\n` +
                    (authUser ? `User: ${authUser.displayName} (${authUser.plan})\n` : "") +
                    "\nCommands: /auth login, /auth logout, /auth github"
                  );
                });
              }).catch(() => {
                addSystemMessage(
                  `Auth Status: ${authStatus}\n` +
                  (authUser ? `User: ${authUser.displayName} (${authUser.plan})\n` : "") +
                  "\nCommands: /auth login, /auth logout, /auth github"
                );
              });
            }
          }
          // Handle /github command
          if ((command as string) === "github") {
            const sub = args[0] || "status";

            if (authStatus !== "authenticated") {
              addSystemMessage("GitHub: Not authenticated. Run /auth login first.");
            } else {
              import("../../../packages/auth/github.js").then(({ getGitHubAuth }) => {
                const gh = getGitHubAuth();
                gh.getToken().then((token) => {
                  if (!token) {
                    addSystemMessage("GitHub: No token available. Try /auth login to reconnect.");
                    return;
                  }

                  import("../../../packages/auth/github-tools.js").then((tools) => {
                    if (sub === "repos") {
                      tools.listRepos(token, { perPage: 15 }).then((repos) => {
                        if (repos.length === 0) {
                          addSystemMessage("No repositories found.");
                          return;
                        }
                        const lines = ["Your repositories:"];
                        for (const r of repos) {
                          const badge = r.isPrivate ? "[private]" : "[public]";
                          lines.push(`  ${badge} ${r.fullName}`);
                        }
                        addSystemMessage(lines.join("\n"));
                      }).catch((err: Error) => addSystemMessage(`GitHub error: ${err.message}`));

                    } else if (sub === "issues") {
                      tools.getCurrentRepoInfo().then((info) => {
                        if (!info) {
                          addSystemMessage("Not in a GitHub repository. Navigate to a repo directory first.");
                          return;
                        }
                        tools.listIssues(token, info.owner, info.repo).then((issues) => {
                          if (issues.length === 0) {
                            addSystemMessage(`No open issues in ${info.owner}/${info.repo}.`);
                            return;
                          }
                          const lines = [`Open issues in ${info.owner}/${info.repo}:`];
                          for (const i of issues) {
                            const labels = i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
                            lines.push(`  #${i.number} ${i.title}${labels}`);
                          }
                          addSystemMessage(lines.join("\n"));
                        }).catch((err: Error) => addSystemMessage(`GitHub error: ${err.message}`));
                      });

                    } else if (sub === "pr") {
                      tools.getCurrentRepoInfo().then((info) => {
                        if (!info) {
                          addSystemMessage("Not in a GitHub repository.");
                          return;
                        }
                        tools.getCurrentBranch().then((branch) => {
                          if (!branch || branch === "main" || branch === "master") {
                            addSystemMessage("Switch to a feature branch before creating a PR.");
                            return;
                          }
                          tools.getDefaultBranch(token, info.owner, info.repo).then((baseBranch) => {
                            const title = args.slice(1).join(" ") || `PR from ${branch}`;
                            tools.createPR(token, info.owner, info.repo, {
                              title,
                              body: `Created via 8gent Code from branch \`${branch}\`.`,
                              head: branch,
                              base: baseBranch,
                            }).then((pr) => {
                              if (pr) {
                                addSystemMessage(`PR #${pr.number} created: ${pr.url}`);
                              } else {
                                addSystemMessage("Failed to create PR. Push your branch first, or a PR may already exist.");
                              }
                            }).catch((err: Error) => addSystemMessage(`GitHub error: ${err.message}`));
                          });
                        });
                      });

                    } else {
                      // Default: show status
                      Promise.all([
                        gh.getUser(),
                        gh.isGhCliAvailable(),
                        tools.getCurrentRepoInfo(),
                      ]).then(([user, ghCli, repoInfo]) => {
                        const lines = ["GitHub Status:"];
                        if (user) {
                          lines.push(`  User: @${user.username} (${user.name})`);
                        } else {
                          lines.push("  User: Not connected");
                        }
                        lines.push(`  gh CLI: ${ghCli ? "Available" : "Not installed"}`);
                        if (repoInfo) {
                          lines.push(`  Repo: ${repoInfo.owner}/${repoInfo.repo}`);
                        }
                        lines.push("\nCommands: /github issues, /github pr [title], /github repos");
                        addSystemMessage(lines.join("\n"));
                      }).catch(() => addSystemMessage("Failed to fetch GitHub status."));
                    }
                  });
                }).catch(() => addSystemMessage("GitHub: Failed to get token."));
              }).catch(() => addSystemMessage("GitHub module not available."));
            }
          }
          // Handle /model command
          if (command === "model" as any) {
            if (args.length > 0) {
              // Direct model set: /model qwen2.5:14b
              const newModel = args.join(" ");
              // Accept any model name — Ollama models, custom fine-tunes, OpenRouter IDs
              setCurrentModel(newModel);
              addSystemMessage(`Model switched to: ${newModel}`);
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
          // Handle /vision command
          else if (command === "vision" as any) {
            handleVisionCommand(args);
          }
          // Workspace tab commands
          else if (command === "notes" as any) {
            workspaceTabs.addTab("notes");
          }
          else if (command === "ideas" as any) {
            workspaceTabs.addTab("ideas");
          }
          else if (command === "btw" as any) {
            workspaceTabs.addTab("btw");
          }
          else if (command === "questions" as any) {
            workspaceTabs.addTab("questions");
          }
          else if (command === "projects" as any) {
            workspaceTabs.addTab("projects");
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
      adhdMode,
      agent,
      orchestration,
      workspaceTabs,
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
    setEvidenceSummary(null);
    clearActivity();
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
  const handleSubmit = async (rawInput: string) => {
    if (!rawInput.trim()) return;

    // Check for image paths in pasted input
    const { text: input, image } = imageInput.processInput(rawInput);
    if (image) {
      addSystemMessage(`📷 Image attached: ${image.filename} (${(image.size / 1024).toFixed(1)} KB)`);
    }

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

    // Track command history
    setRecentCommands((prev) => [input, ...prev].slice(0, 20));

    // Add user message to chat immediately
    setMessages((prev) => [...prev, {
      id: `user-${Date.now()}`,
      role: "user" as const,
      content: input,
      timestamp: new Date(),
    }]);
    // Session logger: user message
    logMessage(activeTabId, workspaceTabs.activeTab?.title || "Chat", "user", input);

    // Auto-kanban: create a card for this user message
    const activeTab = workspaceTabs.activeTab;
    autoKanban.onUserMessage(
      activeTab?.id || "default",
      activeTab?.title || "Chat",
      input,
    );

    // If agent is already running, queue this message
    if (agentRunningRef.current) {
      messageQueueRef.current.push(input);
      addSystemMessage("Queued — will send after current task completes.");
      return;
    }

    // Run the agent
    const runAgent = async (message: string) => {
      agentRunningRef.current = true;
      setIsProcessing(true);
      resetAgentProgress();

      // Reset TV Mode for new task
      setTvTasks([]);
      setNarratorText("Thinking...");

      const cmdStartTime = Date.now();

      // Generate predictions and avenues
      const newPredictions = generatePredictions(message);
      setPredictedSteps(newPredictions);
      setPlanNextStep(newPredictions[0]?.description || null);
      const newAvenues = generateAvenues(message);
      setAvenues(newAvenues);
      setKanbanBoard((prev) => ({
        ...prev,
        ready: newPredictions.slice(0, 3) as any,
        backlog: newPredictions.slice(3) as any,
      }));

      if (agent && agentReady) {
        try {
          // Task Router: classify and potentially switch model
          const router = getTaskRouter();
          const routerConfig = router.getConfig();
          if (routerConfig.enabled) {
            try {
              const decision = await router.route(message);
              if (decision.model !== currentModel && decision.confidence >= routerConfig.confidenceThreshold) {
                // Switch model for this task
                setCurrentModel(decision.model);
                addSystemMessage(`Routed to ${decision.model} (${decision.category}, ${(decision.confidence * 100).toFixed(0)}%)`);
              }
            } catch {
              // Router failed silently — continue with current model
            }
          }

          // Inject agent mode context into the message
          const modePrefix = agentMode !== "Planning" ? `[Mode: ${agentMode}] ` : "";
          const img = imageInput.currentImage;
          await agent.chat(modePrefix + message, img?.base64, img?.mimeType);
          // Clear image after sending
          if (img) imageInput.removeImage();
          setLastResponseTime(Date.now() - cmdStartTime);
          setStatus("success");
          if (soundEnabled) playSound("success");
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError(activeTabId, workspaceTabs.activeTab?.title || "Chat", errorMsg);
          setMessages((prev) => [...prev, {
            id: `assistant-error-${Date.now()}`,
            role: "assistant" as const,
            content: `[Error] ${errorMsg}`,
            timestamp: new Date(),
          }]);
          setStatus("error");
          setTimeout(() => setStatus("idle"), 3000);
        }
      } else {
        // Mock mode
        setTimeout(() => {
          setMessages((prev) => [...prev, {
            id: `assistant-${Date.now()}`,
            role: "assistant" as const,
            content: generateResponse(message),
            timestamp: new Date(),
          }]);
          setLastResponseTime(Date.now() - cmdStartTime);
          setStatus("success");
          if (soundEnabled) playSound("success");
          setTimeout(() => setStatus("idle"), 1500);
        }, 800 + Math.random() * 400);
      }

      setIsProcessing(false);
      setActiveTool(null);
      agentRunningRef.current = false;

      // Process queued messages
      if (messageQueueRef.current.length > 0) {
        const next = messageQueueRef.current.shift()!;
        setMessages((prev) => [...prev, {
          id: `user-queued-${Date.now()}`,
          role: "user" as const,
          content: next,
          timestamp: new Date(),
        }]);
        // Small delay so the UI can breathe
        setTimeout(() => runAgent(next), 100);
      } else {
        setTimeout(() => setStatus("idle"), 1500);
      }
    };

    runAgent(input);

  };

  // Helper to close tab-based views (switch back to first chat tab)
  const closeTabView = () => {
    const chatTab = workspaceTabs.tabs.find(t => t.type === "chat");
    if (chatTab) workspaceTabs.switchTab(chatTab.id);
  };

  // Render main content based on view mode + active tab type
  const renderMainContent = () => {
    // Tab-driven views: when viewMode is "chat", check if the active tab is a utility tab
    if (viewMode === "chat" && activeTabType !== "chat") {
      switch (activeTabType) {
        case "notes":
          return (
            <NotesView
              visible={true}
              data={workspaceTabs.activeTab?.data || {}}
              onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
              onClose={closeTabView}
              chatTabNames={workspaceTabs.getTabsByType("chat").map(t => t.title)}
              onSendToChat={(content) => {
                // Switch to first chat tab and add as user message
                const chatTabs = workspaceTabs.getTabsByType("chat");
                if (chatTabs.length > 0) {
                  workspaceTabs.switchTab(chatTabs[0].id);
                  addSystemMessage(`[From Notes] ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`);
                }
              }}
            />
          );
        case "ideas":
          return (
            <IdeasView
              visible={true}
              data={workspaceTabs.activeTab?.data || {}}
              onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
              onClose={closeTabView}
            />
          );
        case "btw":
          return (
            <BTWView
              visible={true}
              data={workspaceTabs.activeTab?.data || {}}
              onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
              onClose={closeTabView}
            />
          );
        case "questions":
          return (
            <QuestionsView
              visible={true}
              data={workspaceTabs.activeTab?.data || {}}
              onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
              onClose={closeTabView}
            />
          );
        case "projects":
          return (
            <ProjectsView
              visible={true}
              onClose={closeTabView}
            />
          );
        case "kanban":
          return autoKanban.stats.total > 0 ? (
            <AutoPlanKanban
              columns={autoKanban.columns}
              stats={autoKanban.stats}
              visible={true}
              onClose={closeTabView}
              compact={false}
            />
          ) : (
            <PlanKanban
              board={kanbanBoard as any}
              visible={true}
              onClose={closeTabView}
              compact={false}
            />
          );
        case "music":
          return (
            <MusicPlayerView
              visible={true}
              isPlaying={getADHDAudio().isPlaying}
              currentTrack={getADHDAudio().current}
              duration={getADHDAudio().config.duration}
              onPlay={(soundscape) => {
                const audio = getADHDAudio();
                audio.onProgress = (msg) => addSystemMessage(msg);
                audio.play(soundscape as any).then((r) => {
                  addSystemMessage(r.message);
                  audio.onProgress = null;
                });
              }}
              onPlayFile={(filePath) => {
                const audio = getADHDAudio();
                const result = audio.playFile(filePath);
                addSystemMessage(result.message);
              }}
              onStop={() => {
                getADHDAudio().stop();
                addSystemMessage("Music stopped.");
              }}
              onClose={closeTabView}
              onGenerate={(prompt) => {
                addSystemMessage(`Custom gen: "${prompt}" — use /music gen ${prompt}`);
                closeTabView();
              }}
            />
          );
      }
    }

    switch (viewMode) {
      case "kanban":
        return autoKanban.stats.total > 0 ? (
          <AutoPlanKanban
            columns={autoKanban.columns}
            stats={autoKanban.stats}
            visible={true}
            onClose={() => setViewMode("chat")}
            compact={false}
          />
        ) : (
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
        return modelsLoading ? (
          <Box flexDirection="column" padding={1}>
            <AppText bold>Fetching models from {currentProvider}...</AppText>
          </Box>
        ) : (
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

      case "music":
        return (
          <MusicPlayerView
            visible={true}
            isPlaying={getADHDAudio().isPlaying}
            currentTrack={getADHDAudio().current}
            duration={getADHDAudio().config.duration}
            onPlay={(soundscape) => {
              const audio = getADHDAudio();
              audio.onProgress = (msg) => addSystemMessage(msg);
              audio.play(soundscape as any).then((r) => {
                addSystemMessage(r.message);
                audio.onProgress = null;
              });
            }}
            onPlayFile={(filePath) => {
              const audio = getADHDAudio();
              const result = audio.playFile(filePath);
              addSystemMessage(result.message);
            }}
            onStop={() => {
              getADHDAudio().stop();
              addSystemMessage("Music stopped.");
            }}
            onClose={() => setViewMode("chat")}
            onGenerate={(prompt) => {
              addSystemMessage(`Custom gen: "${prompt}" — use /music gen ${prompt}`);
              setViewMode("chat");
            }}
          />
        );

      case "chat":
      default:
        // TV Mode: show task cards when agent is using tools
        // Fall back to message list for text-only conversation
        if (tvTasks.length > 0) {
          return (
            <NarratorView
              tasks={tvTasks}
              narratorText={narratorText}
              maxHeight={Math.max(viewport.height - 12, 10)}
            />
          );
        }
        return (
          <Stack>
            <MessageList
              messages={messages}
              animateTyping={showAnimations}
              soundEnabled={soundEnabled}
            />
            {isProcessing && (
              <ActivityMonitor
                activeTool={activeTool}
                stepCount={stepCount}
                toolCount={toolCount}
                processingStage={processingStage}
              />
            )}
          </Stack>
        );
    }
  };

  return (
    <ADHDModeContext.Provider value={{ enabled: adhdMode, ratio: 0.5 }}>
    <FixedFrame>
      {/* Header */}
      {fancyHeader ? (
        <FancyHeader isProcessing={isProcessing} />
      ) : (
        <Header isProcessing={isProcessing} showAnimations={showAnimations} updateAvailable={updateInfo} />
      )}

      {/* Workspace tab bar */}
      <TabBar tabs={workspaceTabs.tabs} onSwitch={workspaceTabs.switchTab} />

      {/* Main content area with folder frame */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left border */}
        <Box flexDirection="column">
          <AppText color="cyan">│</AppText>
        </Box>
        {/* Main content (chat / kanban / etc.) or process detail */}
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
          ) : (
            renderMainContent()
          )}
        </Box>
        {/* Right border */}
        {!processPanel.sidebarOpen && (
          <Box flexDirection="column">
            <AppText color="cyan">│</AppText>
          </Box>
        )}

        {/* Right: process sidebar */}
        {processPanel.sidebarOpen && (
          <ProcessSidebar
            tasks={processPanel.tasks}
            selectedIndex={processPanel.selectedIndex}
            focused={processPanel.focusZone === "sidebar"}
            taskCounts={processPanel.taskCounts}
            width={32}
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
        )}
      </Box>

      {/* Mini kanban removed — full board available via Ctrl+K */}

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

      {/* Image attachment indicator */}
      {imageInput.currentImage && (
        <Box paddingX={1}>
          <ImageBadge image={imageInput.currentImage} onRemove={imageInput.removeImage} />
        </Box>
      )}

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
            focused={(viewMode === "chat" && activeTabType === "chat") || viewMode === "onboarding"}
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
            injectedText={voiceTranscript}
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
          authStatus={authStatus}
          authUser={authUser}
          voiceState={voiceChat.isActive ? voiceChat.state : voice.state}
          voiceEnabled={voice.isAvailable}
          voiceChatActive={voiceChat.isActive}
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
      {/* Agent mode bar — Ctrl+T to cycle */}
      <Box paddingX={1} marginTop={1} gap={1}>
        {AGENT_MODES.map((mode) => (
          <Box key={mode}>
            {agentMode === mode ? (
              <AppText color="cyan" bold>{`[${mode}]`}</AppText>
            ) : (
              <MutedText>{` ${mode} `}</MutedText>
            )}
          </Box>
        ))}
        <MutedText> ^T mode</MutedText>
        {!processPanel.sidebarOpen && <ProcessBadge counts={processPanel.taskCounts} />}
      </Box>

      {showAnimations && (
        <Box paddingX={1} gap={2}>
          <MutedText>
            ^O expand | ^B processes | ^K kanban | ^P predict | ^A anim | ^S sound | ^C exit
          </MutedText>
        </Box>
      )}
    </FixedFrame>
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
