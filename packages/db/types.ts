/**
 * @8gent/db — Shared Type Definitions
 *
 * Types used across the database layer and consumers.
 * These mirror the Convex schema but are framework-agnostic.
 */

// ============================================
// User
// ============================================

export interface DbUser {
  _id: string;
  clerkId: string;
  email: string;
  githubUsername: string;
  displayName: string;
  avatar: string;
  plan: "free" | "pro" | "team";
  createdAt: number;
  lastActiveAt: number;
}

export interface CreateUserInput {
  clerkId: string;
  email: string;
  githubUsername: string;
  displayName: string;
  avatar: string;
}

export interface UpdateUserInput {
  clerkId: string;
  email?: string;
  githubUsername?: string;
  displayName?: string;
  avatar?: string;
  plan?: "free" | "pro" | "team";
}

// ============================================
// Session
// ============================================

export interface DbSession {
  _id: string;
  userId: string;
  startedAt: number;
  endedAt?: number;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  benchmarkScores?: Record<string, number>;
}

export interface StartSessionInput {
  model: string;
  provider: string;
}

export interface UpdateSessionInput {
  sessionId: string;
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: number;
}

export interface EndSessionInput {
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  benchmarkScores?: Record<string, number>;
}

// ============================================
// Usage
// ============================================

export interface DbUsage {
  _id: string;
  userId: string;
  date: string; // YYYY-MM-DD
  tokensIn: number;
  tokensOut: number;
  sessions: number;
  models: string[];
}

export interface UsageSummary {
  totalTokensIn: number;
  totalTokensOut: number;
  totalSessions: number;
  uniqueModels: string[];
  days: number;
}

// ============================================
// Preferences
// ============================================

export interface DbPreferences {
  _id: string;
  userId: string;
  defaultModel: string;
  defaultProvider: string;
  theme: string;
  loraStatus: "none" | "training" | "ready";
  loraVersion?: string;
  customPromptMutations: string[];
  updatedAt: number;
}

export interface PreferencesInput {
  defaultModel?: string;
  defaultProvider?: string;
  theme?: string;
  loraStatus?: "none" | "training" | "ready";
  loraVersion?: string;
  customPromptMutations?: string[];
}

/** Default preferences for new users. */
export const DEFAULT_PREFERENCES: Omit<DbPreferences, "_id" | "userId" | "updatedAt"> = {
  defaultModel: "",
  defaultProvider: "ollama",
  theme: "default",
  loraStatus: "none",
  customPromptMutations: [],
};
