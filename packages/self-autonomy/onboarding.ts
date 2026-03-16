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

// ============================================
// Onboarding Questions
// ============================================

const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  {
    step: "identity",
    question:
      "Good day. I'm 8gent, The Infinite Gentleman.\n\nBefore we begin, what should I call you?",
    processor: (answer, user) => ({
      ...user,
      identity: { ...user.identity, name: answer.trim() },
      completedSteps: [...user.completedSteps, "identity"],
    }),
  },
  {
    step: "role",
    question:
      "Splendid, {name}.\n\nWhat's your role? (developer, founder, student, designer, etc.)",
    processor: (answer, user) => ({
      ...user,
      identity: { ...user.identity, role: answer.trim().toLowerCase() },
      completedSteps: [...user.completedSteps, "role"],
    }),
  },
  {
    step: "projects",
    question:
      "Tell me about your main project.\nWhat are you building? (Brief description)",
    processor: (answer, user) => ({
      ...user,
      projects: {
        ...user.projects,
        primary: answer.trim(),
        all: [answer.trim()],
      },
      completedSteps: [...user.completedSteps, "projects"],
    }),
  },
  {
    step: "communication",
    question:
      "How should I communicate with you?\n\n" +
      "1. Concise & direct (just the facts)\n" +
      "2. Detailed & explanatory (teach me as we go)\n" +
      "3. Casual & friendly (we're collaborators)\n" +
      "4. Formal & precise (professional tone)",
    options: ["1", "2", "3", "4", "concise", "detailed", "casual", "formal"],
    processor: (answer, user) => {
      const styleMap: Record<string, CommunicationStyle> = {
        "1": "concise",
        "2": "detailed",
        "3": "casual",
        "4": "formal",
        concise: "concise",
        detailed: "detailed",
        casual: "casual",
        formal: "formal",
      };
      const style = styleMap[answer.toLowerCase()] || "concise";
      return {
        ...user,
        identity: { ...user.identity, communicationStyle: style },
        completedSteps: [...user.completedSteps, "communication"],
      };
    },
  },
  {
    step: "language",
    question:
      "What language should I respond in?\n(en, es, pt, de, fr, zh, ja, etc.)",
    processor: (answer, user) => ({
      ...user,
      identity: { ...user.identity, language: answer.trim().toLowerCase() || "en" },
      completedSteps: [...user.completedSteps, "language"],
    }),
  },
  {
    step: "model",
    question:
      "Let's set up your AI engine.\n\n" +
      "Which provider would you like to use?\n" +
      "1. Ollama (local)\n" +
      "2. LM Studio (local)\n" +
      "3. OpenRouter (cloud, many models)\n" +
      "4. OpenAI (cloud)\n" +
      "5. Anthropic (cloud)\n\n" +
      "(I'll detect available models after selection)",
    options: ["1", "2", "3", "4", "5", "ollama", "lmstudio", "openrouter", "openai", "anthropic"],
    processor: (answer, user) => {
      const providerMap: Record<string, UserConfig["preferences"]["model"]["provider"]> = {
        "1": "ollama",
        "2": "lmstudio",
        "3": "openrouter",
        "4": "openai",
        "5": "anthropic",
        ollama: "ollama",
        lmstudio: "lmstudio",
        openrouter: "openrouter",
        openai: "openai",
        anthropic: "anthropic",
      };
      const provider = providerMap[answer.toLowerCase()] || "ollama";
      return {
        ...user,
        preferences: {
          ...user.preferences,
          model: {
            ...user.preferences.model,
            provider,
            preferLocal: provider === "ollama" || provider === "lmstudio",
          },
        },
        completedSteps: [...user.completedSteps, "model"],
      };
    },
  },
  {
    step: "voice",
    question:
      "I can speak to you if you'd like.\nEnable voice output? (yes/no)",
    options: ["yes", "no", "y", "n"],
    processor: (answer, user) => ({
      ...user,
      preferences: {
        ...user.preferences,
        voice: {
          ...user.preferences.voice,
          enabled: ["yes", "y"].includes(answer.toLowerCase()),
        },
      },
      completedSteps: [...user.completedSteps, "voice"],
    }),
  },
  {
    step: "telegram",
    question:
      "Would you like to set up Telegram for remote control? (y/n)\n\n" +
      "This lets you control 8gent from your phone — switch models,\n" +
      "run tasks, and chat with the agent from anywhere.",
    options: ["yes", "no", "y", "n"],
    processor: (answer, user) => {
      const wantsTelegram = ["yes", "y"].includes(answer.toLowerCase());
      if (wantsTelegram) {
        console.log(
          "\n\x1b[36mGreat!\x1b[0m After onboarding, run \x1b[33m/telegram setup\x1b[0m to connect your bot.\n" +
          "\x1b[90mYou'll need: Open Telegram → @BotFather → /newbot → copy the token.\x1b[0m\n"
        );
      }
      return {
        ...user,
        completedSteps: [...user.completedSteps, "telegram"],
      };
    },
  },
  {
    step: "confirmation",
    question:
      "Excellent. Let me confirm what I've learned:\n\n" +
      "- Name: {name}\n" +
      "- Role: {role}\n" +
      "- Project: {project}\n" +
      "- Style: {style}\n" +
      "- Language: {language}\n" +
      "- Model: {provider}\n" +
      "- Voice: {voice}\n" +
      "- Telegram: {telegram}\n\n" +
      "Is this correct? (yes/no)",
    options: ["yes", "no", "y", "n"],
    processor: (answer, user) => {
      if (["yes", "y"].includes(answer.toLowerCase())) {
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
      // If no, reset to start over
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
