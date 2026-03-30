/**
 * 8gent Code - Onboarding System
 *
 * First-run personalization. 8gent learns who you are,
 * how you work, and what you prefer.
 *
 * A proper gentleman knows his employer.
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { getVault } from "../secrets";

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

export interface UserConfig {
  version: string;
  onboardingComplete: boolean;
  completedSteps: OnboardingStep[];
  lastPrompted: string | null;
  promptCount: number;

  identity: {
    name: string | null;
    role: string | null;
    communicationStyle: CommunicationStyle | null;
    language: string;
  };

  projects: {
    primary: string | null;
    all: string[];
    descriptions: Record<string, string>;
  };

  preferences: {
    voice: {
      enabled: boolean;
      engine: "system" | "elevenlabs" | null;
      voiceId: string | null;
    };
    model: {
      default: string | null;
      provider: "ollama" | "lmstudio" | "openai" | "anthropic" | "openrouter" | null;
      fallbacks: string[];
      preferLocal: boolean;
    };
    git: {
      autoPush: boolean;
      autoCommit: boolean;
      branchPrefix: string;
      commitStyle: "conventional" | "simple";
    };
    autonomy: {
      askThreshold: "always" | "important" | "fatal-only" | "never";
      infiniteByDefault: boolean;
    };
  };

  integrations: {
    github: {
      authenticated: boolean;
      username: string | null;
    };
    mcps: string[];
    ollama: {
      available: boolean;
      models: string[];
    };
    lmstudio: {
      available: boolean;
      models: string[];
    };
  };

  understanding: {
    confidenceScore: number;
    areasUnclear: string[];
    lastUpdated: string | null;
  };
}

export type OnboardingStep =
  | "identity"
  | "role"
  | "projects"
  | "communication"
  | "language"
  | "model"
  | "voice"
  | "telegram"
  | "github"
  | "mcps"
  | "confirmation";

export type CommunicationStyle =
  | "concise"      // Just the facts
  | "detailed"     // Teach me as we go
  | "casual"       // We're collaborators
  | "formal";      // Professional tone

export interface OnboardingQuestion {
  step: OnboardingStep;
  question: string;
  options?: string[];
  validator?: (answer: string) => boolean;
  processor: (answer: string, user: UserConfig) => UserConfig;
}

export interface AutoDetected {
  name: string | null;
  email: string | null;
  ollamaModels: string[];
  githubUsername: string | null;
  preferredProvider: "ollama" | "lmstudio" | "openrouter" | null;
}

// ============================================
// Onboarding Questions
// ============================================

// ── Vibe Detection ─────────────────────────────────────────
// After the first couple of questions, detect the user's personality
// and adapt the rest of the onboarding to feel like home.

type VibeType = "hacker" | "creative" | "nerd" | "exec" | "chill" | "unknown";

function detectVibe(name: string, style: CommunicationStyle): VibeType {
  const lower = name.toLowerCase();
  // Fantasy/nerdy indicators
  if (/gandalf|frodo|aragorn|legolas|bilbo|sauron|elf|wizard|mage|dungeon|dragon|hobbit|shire/i.test(lower)) return "nerd";
  if (style === "casual") return "chill";
  if (style === "formal") return "exec";
  if (style === "detailed") return "creative";
  if (style === "concise") return "hacker";
  return "unknown";
}

function vibeGreeting(vibe: VibeType, name: string): string {
  switch (vibe) {
    case "nerd": return `A fellow traveler. Welcome, ${name}. The quest begins.`;
    case "hacker": return `Right. ${name}. Let's build something.`;
    case "creative": return `${name} - I can already tell we're going to make beautiful things together.`;
    case "exec": return `${name}, pleasure to meet you. I'm ready when you are.`;
    case "chill": return `Nice to meet you, ${name}. Let's keep it easy.`;
    default: return `Welcome, ${name}. This is going to be good.`;
  }
}

function vibeMusic(vibe: VibeType): string {
  switch (vibe) {
    case "nerd": return "epic orchestral";
    case "hacker": return "synthwave";
    case "creative": return "lofi hip hop";
    case "exec": return "jazz";
    case "chill": return "ambient";
    default: return "lofi hip hop";
  }
}

// ── Onboarding Side Effects ────────────────────────────────
// These fire during onboarding to create magical moments.

async function startVibeMusic(genre: string): Promise<void> {
  try {
    const { DJ } = await import("../../packages/music/dj.ts");
    const dj = new DJ();
    await dj.radio(genre);
    // Lower volume for background vibes
    const { execSync } = require("child_process");
    try { execSync("osascript -e 'set volume output volume 25'", { stdio: "ignore" }); } catch {}
  } catch {
    // Music not available - that's fine, skip silently
  }
}

async function spawnCompanion(): Promise<void> {
  try {
    const { execSync } = require("child_process");
    // Try to spawn Lil Eight dock pet
    execSync("open -g /Applications/LilEight.app 2>/dev/null || true", { stdio: "ignore" });
  } catch {
    // Companion not installed - skip
  }
}

// ============================================
// Onboarding Questions - The Magic Flow
// ============================================
//
// Flow:
// 1. Identity (auto-detect + name)
// 2. Communication style
// 3. >>> VIBE MOMENT: music or companion based on detected personality <<<
// 4. Agent name + voice
// 5. Telegram (optional)
// 6. Confirmation (personalized based on vibe)

const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  // ── Step 1: Who are you? ───────────────────────────────
  {
    step: "identity",
    question:
      "Good day. I'm Eight - The Infinite Gentleman.\n\n" +
      "I've already had a look around:\n" +
      "  Name: {detected_name}\n" +
      "  Email: {detected_email}\n" +
      "  GitHub: {detected_github}\n" +
      "  Models: {detected_models}\n\n" +
      "Is that you? Press Enter to confirm, or type your name:",
    processor: (answer, user) => {
      const name = answer.trim() || user.identity.name;
      return {
        ...user,
        identity: { ...user.identity, name: name || user.identity.name },
        completedSteps: [...user.completedSteps, "identity", "role", "projects", "model", "language", "github", "mcps"],
      };
    },
  },
  // ── Step 2: How do you like to work? ───────────────────
  {
    step: "communication",
    question:
      "How do you like to work?\n\n" +
      "1. Fast and direct - no fluff, just results\n" +
      "2. Teach me as we go - I like to understand\n" +
      "3. Like friends working together - keep it casual\n" +
      "4. Professional and precise - this is serious work",
    options: ["1", "2", "3", "4", "concise", "detailed", "casual", "formal"],
    processor: (answer, user) => {
      const styleMap: Record<string, CommunicationStyle> = {
        "1": "concise", "2": "detailed", "3": "casual", "4": "formal",
        concise: "concise", detailed: "detailed", casual: "casual", formal: "formal",
      };
      const style = styleMap[answer.toLowerCase()] || "concise";
      const name = user.identity.name || "friend";
      const vibe = detectVibe(name, style);

      // >>> THE MAGIC MOMENT <<<
      // Based on detected vibe, either start music or spawn companion
      if (vibe === "nerd") {
        // Spawn the companion pet for the nerdy types
        spawnCompanion().catch(() => {});
      } else {
        // Start background music for everyone else
        const genre = vibeMusic(vibe);
        startVibeMusic(genre).catch(() => {});
      }

      return {
        ...user,
        identity: { ...user.identity, communicationStyle: style },
        completedSteps: [...user.completedSteps, "communication"],
      };
    },
  },
  // ── Step 3: The vibe check ─────────────────────────────
  // This question adapts based on what just happened
  {
    step: "voice" as OnboardingStep,
    question:
      "{vibe_message}\n\n" +
      "What should I be called? (default: Eight)\n\n" +
      "This is your personal AI. Name me whatever you want.\n" +
      "Some people go with their own name. Some pick something wild.\n" +
      "Press Enter for Eight, or type a name:",
    processor: (answer, user) => {
      const agentName = answer.trim() || "Eight";
      return {
        ...user,
        preferences: {
          ...user.preferences,
          voice: {
            ...user.preferences.voice,
            voiceId: user.preferences.voice?.voiceId ?? "Moira",
            agentName,
          } as any,
        },
        completedSteps: [...user.completedSteps, "voice"],
      };
    },
  },
  // ── Step 4: Voice selection ────────────────────────────
  {
    step: "voice" as OnboardingStep,
    question:
      "Pick a voice (I'll speak to you when tasks complete):\n\n" +
      "1. Moira    (Irish - the original Gentleman)\n" +
      "2. Daniel   (British - distinguished)\n" +
      "3. Samantha (American - friendly)\n" +
      "4. Karen    (Australian - no-nonsense)\n" +
      "5. Rishi    (Indian - our 8TO officer)\n" +
      "6. Reed     (American - deep)\n" +
      "7. Surprise me\n\n" +
      "Choose 1-7:",
    options: ["1", "2", "3", "4", "5", "6", "7"],
    processor: (answer, user) => {
      const voiceMap: Record<string, string> = {
        "1": "Moira", "2": "Daniel", "3": "Samantha",
        "4": "Karen", "5": "Rishi", "6": "Reed",
      };
      let voice: string;
      if (answer === "7") {
        // Surprise - pick a voice based on their vibe
        const style = user.identity.communicationStyle || "concise";
        const vibe = detectVibe(user.identity.name || "", style);
        const surpriseMap: Record<VibeType, string> = {
          nerd: "Daniel", hacker: "Reed", creative: "Samantha",
          exec: "Moira", chill: "Karen", unknown: "Moira",
        };
        voice = surpriseMap[vibe];
      } else {
        voice = voiceMap[answer] || "Moira";
      }
      // Say hello in the chosen voice
      try {
        const { execSync } = require("child_process");
        const name = user.identity.name || "friend";
        execSync(`say -v ${voice} "Hello ${name}. I'm ${(user.preferences.voice as any)?.agentName || 'Eight'}. Lovely to meet you."`, { stdio: "ignore" });
      } catch {}
      return {
        ...user,
        preferences: {
          ...user.preferences,
          voice: {
            ...user.preferences.voice,
            enabled: true,
            engine: "system" as any,
            voiceId: voice,
          },
        },
      };
    },
  },
  // ── Step 5: Telegram (optional) ────────────────────────
  {
    step: "telegram" as OnboardingStep,
    question:
      "Want me on your phone too? I can run as a Telegram bot.\n\n" +
      "1. Yes - set it up\n" +
      "2. Not now - I'll do /telegram later\n\n" +
      "(If yes: message @BotFather on Telegram, create a bot, paste the token)",
    options: ["1", "2", "yes", "skip", "no"],
    processor: (answer, user) => {
      const lower = answer.toLowerCase().trim();
      if (["2", "skip", "no", "not now"].includes(lower)) {
        return { ...user, completedSteps: [...user.completedSteps, "telegram"] };
      }
      if (/^\d+:/.test(answer.trim())) {
        return {
          ...user,
          preferences: { ...user.preferences, telegramToken: answer.trim() },
          completedSteps: [...user.completedSteps, "telegram"],
        } as any;
      }
      return { ...user, completedSteps: [...user.completedSteps, "telegram"] };
    },
  },
  // ── Step 6: Confirmation ───────────────────────────────
  {
    step: "confirmation",
    question:
      "{confirmation_message}\n\n" +
      "Ready? (yes/no)",
    options: ["yes", "no", "y", "n", "let's go", "yep", "absolutely"],
    processor: (answer, user) => {
      if (["yes", "y", "", "let's go", "yep", "absolutely", "lets go"].includes(answer.toLowerCase())) {
        // Stop the onboarding music - the real work begins
        try {
          const { execSync } = require("child_process");
          execSync("pkill -f mpv 2>/dev/null || true", { stdio: "ignore" });
        } catch {}
        return {
          ...user,
          onboardingComplete: true,
          completedSteps: [...user.completedSteps, "confirmation"],
          understanding: {
            ...user.understanding,
            confidenceScore: calculateConfidence(user),
            areasUnclear: [],
            lastUpdated: new Date().toISOString(),
          },
        };
      }
      return getDefaultUserConfig();
    },
  },
];

// ============================================
// Onboarding Manager
// ============================================

export class OnboardingManager {
  private userConfigPath: string;
  private user: UserConfig;

  constructor(workingDirectory: string = process.cwd()) {
    this.userConfigPath = path.join(workingDirectory, ".8gent", "user.json");
    this.user = this.loadUserConfig();
  }

  /**
   * Auto-detect user environment: git config, ollama models, gh auth.
   * Returns detected values so onboarding can skip questions.
   */
  static async autoDetect(): Promise<AutoDetected> {
    const detected: AutoDetected = {
      name: null,
      email: null,
      ollamaModels: [],
      githubUsername: null,
      preferredProvider: null,
    };

    const checks = await Promise.allSettled([
      // Git config name
      execAsync("git config --global user.name 2>/dev/null").then(({ stdout }) => {
        detected.name = stdout.trim() || null;
      }),
      // Git config email
      execAsync("git config --global user.email 2>/dev/null").then(({ stdout }) => {
        detected.email = stdout.trim() || null;
      }),
      // Ollama models
      execAsync("ollama list 2>/dev/null").then(({ stdout }) => {
        detected.ollamaModels = stdout
          .split("\n")
          .slice(1)
          .map((line) => line.split(/\s+/)[0])
          .filter(Boolean);
        if (detected.ollamaModels.length > 0) {
          detected.preferredProvider = "ollama";
        }
      }),
      // GitHub auth
      execAsync("gh auth status 2>&1").then(({ stdout }) => {
        const match = stdout.match(/Logged in to github.com account (\S+)/);
        detected.githubUsername = match?.[1] || null;
      }),
    ]);

    return detected;
  }

  /**
   * Apply auto-detected values to user config.
   * Called before onboarding starts to pre-fill detected values.
   */
  applyAutoDetected(detected: AutoDetected): void {
    if (detected.name) {
      this.user.identity.name = detected.name;
    }
    if (detected.preferredProvider) {
      this.user.preferences.model.provider = detected.preferredProvider;
      this.user.preferences.model.preferLocal = detected.preferredProvider === "ollama" || detected.preferredProvider === "lmstudio";
    }
    if (detected.ollamaModels.length > 0) {
      this.user.integrations.ollama = { available: true, models: detected.ollamaModels };
      // Set default model to first available
      if (!this.user.preferences.model.default) {
        this.user.preferences.model.default = detected.ollamaModels[0];
      }
    }
    if (detected.githubUsername) {
      this.user.integrations.github = { authenticated: true, username: detected.githubUsername };
    }
    this.saveUserConfig();
  }

  private loadUserConfig(): UserConfig {
    try {
      if (fs.existsSync(this.userConfigPath)) {
        const content = fs.readFileSync(this.userConfigPath, "utf-8");
        return JSON.parse(content) as UserConfig;
      }
    } catch {
      // Fall through to default
    }
    return getDefaultUserConfig();
  }

  private saveUserConfig(): void {
    const dir = path.dirname(this.userConfigPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.userConfigPath, JSON.stringify(this.user, null, 2));
  }

  /**
   * Check if onboarding is needed
   */
  needsOnboarding(): boolean {
    return !this.user.onboardingComplete;
  }

  /**
   * Check if we should ask a clarification question
   */
  shouldAskClarification(): boolean {
    if (this.user.onboardingComplete && this.user.understanding.confidenceScore < 0.8) {
      return true;
    }
    // Also ask weekly
    if (this.user.lastPrompted) {
      const lastPrompt = new Date(this.user.lastPrompted);
      const daysSince = (Date.now() - lastPrompt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 7) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the next onboarding question
   */
  getNextQuestion(): OnboardingQuestion | null {
    if (this.user.onboardingComplete) {
      return null;
    }

    for (const question of ONBOARDING_QUESTIONS) {
      if (!this.user.completedSteps.includes(question.step)) {
        return this.interpolateQuestion(question);
      }
    }

    return null;
  }

  /**
   * Get a clarification question for incomplete understanding
   */
  getClarificationQuestion(): string | null {
    const unclear = this.user.understanding.areasUnclear[0];
    if (!unclear) return null;

    const clarifications: Record<string, string> = {
      identity: "I don't have your name on file. What should I call you?",
      projects: "What project are you primarily working on?",
      preferences: "How would you like me to communicate with you?",
      integrations: "Are you using local models (Ollama/LM Studio) or cloud?",
    };

    return clarifications[unclear] || null;
  }

  /**
   * Process an answer to the current question
   */
  processAnswer(answer: string): { success: boolean; nextQuestion: OnboardingQuestion | null } {
    const currentQuestion = this.getNextQuestion();
    if (!currentQuestion) {
      return { success: false, nextQuestion: null };
    }

    // Validate if validator exists
    if (currentQuestion.validator && !currentQuestion.validator(answer)) {
      return { success: false, nextQuestion: currentQuestion };
    }

    // Process the answer
    this.user = currentQuestion.processor(answer, this.user);
    this.user.promptCount++;
    this.user.lastPrompted = new Date().toISOString();
    this.saveUserConfig();

    return { success: true, nextQuestion: this.getNextQuestion() };
  }

  /**
   * Skip current question
   */
  skipQuestion(): OnboardingQuestion | null {
    const current = this.getNextQuestion();
    if (current) {
      this.user.completedSteps.push(current.step);
      this.user.understanding.areasUnclear.push(current.step);
      this.saveUserConfig();
    }
    return this.getNextQuestion();
  }

  /**
   * Skip all remaining questions
   */
  skipAll(): void {
    this.user.onboardingComplete = true;
    this.user.understanding.confidenceScore = calculateConfidence(this.user);
    this.saveUserConfig();
  }

  /**
   * Get current user config
   */
  getUser(): UserConfig {
    return { ...this.user };
  }

  /**
   * Update specific user preferences
   */
  updatePreferences(updates: Partial<UserConfig["preferences"]>): void {
    this.user.preferences = { ...this.user.preferences, ...updates };
    this.user.understanding.lastUpdated = new Date().toISOString();
    this.saveUserConfig();
  }

  /**
   * Reset onboarding completely
   */
  reset(): void {
    this.user = getDefaultUserConfig();
    this.saveUserConfig();
  }

  /**
   * Detect available integrations (non-blocking)
   */
  async detectIntegrations(): Promise<void> {
    // Run all checks in parallel, non-blocking
    const checks = await Promise.allSettled([
      // Check Ollama
      execAsync("ollama list 2>/dev/null").then(({ stdout }) => {
        const models = stdout
          .split("\n")
          .slice(1)
          .map((line) => line.split(/\s+/)[0])
          .filter(Boolean);
        this.user.integrations.ollama = { available: true, models };
      }).catch(() => {
        this.user.integrations.ollama = { available: false, models: [] };
      }),

      // Check LM Studio
      fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(2000) })
        .then(async (response) => {
          if (response.ok) {
            const data = await response.json();
            const models = data.data?.map((m: any) => m.id) || [];
            this.user.integrations.lmstudio = { available: true, models };
          }
        }).catch(() => {
          this.user.integrations.lmstudio = { available: false, models: [] };
        }),

      // Check GitHub
      execAsync("gh auth status 2>&1").then(({ stdout }) => {
        const usernameMatch = stdout.match(/Logged in to github.com account (\S+)/);
        this.user.integrations.github = {
          authenticated: true,
          username: usernameMatch?.[1] || null,
        };
      }).catch(() => {
        this.user.integrations.github = { authenticated: false, username: null };
      }),
    ]);

    this.saveUserConfig();
  }

  /**
   * Interpolate user values into question text
   */
  private interpolateQuestion(question: OnboardingQuestion): OnboardingQuestion {
    let text = question.question;
    text = text.replace("{name}", this.user.identity.name || "friend");
    text = text.replace("{role}", this.user.identity.role || "developer");
    text = text.replace("{project}", this.user.projects.primary || "your project");
    text = text.replace("{style}", this.user.identity.communicationStyle || "concise");
    text = text.replace("{language}", this.user.identity.language || "en");
    text = text.replace("{provider}", this.user.preferences.model.provider || "ollama");
    text = text.replace("{voice}", this.user.preferences.voice.enabled ? "enabled" : "disabled");
    text = text.replace("{telegram}", getVault().has("TELEGRAM_BOT_TOKEN") ? "configured" : "not set up");
    text = text.replace("{detected_name}", this.user.identity.name || "not detected");
    text = text.replace("{detected_email}", this.user.integrations?.github?.username ? `(via git)` : "not detected");
    text = text.replace("{detected_github}", this.user.integrations.github.username || "not detected");
    text = text.replace("{detected_provider}", this.user.preferences.model.provider || "not detected");
    text = text.replace("{detected_models}", this.user.integrations.ollama.models.slice(0, 3).join(", ") || "none found");

    // Vibe-aware templates
    const name = this.user.identity.name || "friend";
    const style = this.user.identity.communicationStyle || "concise";
    const vibe = detectVibe(name, style);
    const greeting = vibeGreeting(vibe, name);

    // The vibe message plays after music starts or companion spawns
    let vibeMsg = greeting;
    if (vibe === "nerd") {
      vibeMsg += "\n\nI've summoned a companion to keep you company. Check your dock.";
    } else {
      vibeMsg += `\n\nI put some ${vibeMusic(vibe)} on while we set things up. Hope that's alright.`;
    }
    text = text.replace("{vibe_message}", vibeMsg);

    // Personalized confirmation
    const agentName = (this.user.preferences.voice as any)?.agentName || "Eight";
    const confirmLines = [
      `Here's what I know about you, ${name}:`,
      "",
      `  Name: ${name}`,
      `  Style: ${style}`,
      `  Agent: ${agentName}`,
      `  Voice: ${this.user.preferences.voice?.voiceId || "Moira"}`,
      `  Provider: ${this.user.preferences.model.provider || "ollama"}`,
      "",
      vibe === "nerd" ? "Your companion awaits in the dock. The adventure begins."
        : vibe === "hacker" ? "Zero config left. Let's ship."
        : vibe === "creative" ? "Everything is set. Let's make something beautiful."
        : vibe === "exec" ? "Configuration complete. I'm at your service."
        : "We're good to go. This is going to be fun.",
    ];
    text = text.replace("{confirmation_message}", confirmLines.join("\n"));

    return { ...question, question: text };
  }
}

// ============================================
// Helpers
// ============================================

function getDefaultUserConfig(): UserConfig {
  return {
    version: "0.1.0",
    onboardingComplete: false,
    completedSteps: [],
    lastPrompted: null,
    promptCount: 0,
    identity: {
      name: null,
      role: null,
      communicationStyle: null,
      language: "en",
    },
    projects: {
      primary: null,
      all: [],
      descriptions: {},
    },
    preferences: {
      voice: {
        enabled: false,
        engine: null,
        voiceId: null,
      },
      model: {
        default: null,
        provider: null,
        fallbacks: [],
        preferLocal: true,
      },
      git: {
        autoPush: false,
        autoCommit: true,
        branchPrefix: "8gent/",
        commitStyle: "conventional",
      },
      autonomy: {
        askThreshold: "fatal-only",
        infiniteByDefault: false,
      },
    },
    integrations: {
      github: {
        authenticated: false,
        username: null,
      },
      mcps: [],
      ollama: {
        available: false,
        models: [],
      },
      lmstudio: {
        available: false,
        models: [],
      },
    },
    understanding: {
      confidenceScore: 0,
      areasUnclear: ["identity", "projects", "preferences", "integrations"],
      lastUpdated: null,
    },
  };
}

function calculateConfidence(user: UserConfig): number {
  let score = 0;

  // Identity: 20%
  if (user.identity.name) score += 0.1;
  if (user.identity.role) score += 0.05;
  if (user.identity.communicationStyle) score += 0.05;

  // Projects: 20%
  if (user.projects.primary) score += 0.15;
  if (user.projects.all.length > 0) score += 0.05;

  // Preferences: 20%
  if (user.preferences.model.provider) score += 0.1;
  if (user.preferences.model.default) score += 0.05;
  if (user.preferences.voice.enabled !== null) score += 0.05;

  // Integrations: 20%
  if (user.integrations.ollama.available || user.integrations.lmstudio.available) score += 0.1;
  if (user.integrations.github.authenticated) score += 0.1;

  // Usage patterns: 20% (learned over time)
  // This increases as the user interacts more
  const interactions = Math.min(user.promptCount / 50, 1);
  score += interactions * 0.2;

  return Math.min(score, 1);
}

// ============================================
// Telegram Setup Flow (deterministic, no LLM)
// ============================================

/**
 * Interactive Telegram setup. Reads token via stdin (not LLM).
 * Stores the token in the encrypted SecretVault.
 *
 * @param rl - readline interface for stdin input
 * @returns true if setup completed, false if cancelled
 */
export async function runTelegramSetup(
  rl: import("readline").Interface,
): Promise<boolean> {
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log(`
\x1b[36m╔══════════════════════════════════════════════════╗
║          Telegram Bot Setup                      ║
╚══════════════════════════════════════════════════╝\x1b[0m

\x1b[33mStep 1:\x1b[0m Open Telegram and search for @BotFather
\x1b[33mStep 2:\x1b[0m Send /newbot and follow the prompts
\x1b[33mStep 3:\x1b[0m Copy the bot token (looks like 123456:ABC-DEF...)
`);

  const token = (await ask("\x1b[36mPaste your bot token:\x1b[0m ")).trim();
  if (!token || token.length < 20) {
    console.log("\x1b[31mInvalid token. Setup cancelled.\x1b[0m");
    return false;
  }

  // Validate the token against Telegram API
  console.log("\x1b[90mValidating token...\x1b[0m");
  try {
    const { validateToken } = await import("../telegram");
    const result = await validateToken(token);
    if (!result.valid) {
      console.log(`\x1b[31mToken invalid: ${result.error}\x1b[0m`);
      return false;
    }
    console.log(`\x1b[32mToken valid! Bot: @${result.username}\x1b[0m`);
  } catch {
    console.log("\x1b[33mCouldn't validate token (network error). Storing anyway.\x1b[0m");
  }

  // Store in vault
  const vault = getVault();
  vault.set("TELEGRAM_BOT_TOKEN", token);
  console.log("\x1b[32mToken encrypted with AES-256-GCM and stored in vault.\x1b[0m");
  console.log("\x1b[90mYour token is never exposed to the AI.\x1b[0m");

  // Chat ID
  console.log(`
\x1b[33mChat ID (optional):\x1b[0m
To restrict who can control your bot, you can add your Telegram user/chat ID.
To find it: message @userinfobot on Telegram, it will reply with your ID.
Leave blank to allow all users.
`);

  const chatId = (await ask("\x1b[36mYour Telegram chat ID (or press Enter to skip):\x1b[0m ")).trim();
  if (chatId && /^\d+$/.test(chatId)) {
    vault.set("TELEGRAM_CHAT_ID", chatId);
    console.log(`\x1b[32mChat ID stored.\x1b[0m Only user ${chatId} can control the bot.`);
  } else if (chatId) {
    console.log("\x1b[33mInvalid chat ID (must be numeric). Skipped.\x1b[0m");
  }

  console.log(`
\x1b[32mTelegram setup complete!\x1b[0m
Use \x1b[36m/telegram start\x1b[0m to launch the bot, or it will auto-start next session.
`);

  return true;
}

// ============================================
// Exports
// ============================================

export default {
  OnboardingManager,
  getDefaultUserConfig,
  runTelegramSetup,
};
