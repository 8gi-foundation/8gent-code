/**
 * @8gent/telegram-bot — Type definitions
 *
 * All interfaces for the 8gent Telegram bot system:
 * competition rounds, benchmark reports, overnight summaries, alerts.
 */

// ── Telegram API Types ──────────────────────────────────

export interface TelegramResponse {
  ok: boolean;
  result?: any;
  description?: string;
  error_code?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageOptions {
  parseMode?: "Markdown" | "HTML";
  replyMarkup?: InlineKeyboardMarkup;
  disablePreview?: boolean;
}

// ── Competition Types ───────────────────────────────────

export interface BenchmarkScore {
  id: string;
  name: string;
  score: number;
  maxScore: number;
  passing: boolean;
  tier: "basic" | "intermediate" | "advanced" | "expert";
  previousScore?: number;
  trend?: "up" | "down" | "stable";
}

export interface CompetitionRound {
  roundNumber: number;
  timestamp: string;
  model: string;
  opponent?: string;
  scores: BenchmarkScore[];
  avgScore: number;
  previousAvgScore?: number;
  passing: number;
  total: number;
  duration: {
    startTime: string;
    endTime: string;
    totalMs: number;
  };
  mutations: string[];
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
}

export interface BenchmarkReport {
  timestamp: string;
  model: string;
  iteration: number;
  scores: Record<string, number>;
  avgScore: number;
  previousAvgScore?: number;
  passing: number;
  total: number;
  totalTokens?: number;
  totalDurationMs?: number;
  tierBreakdown: TierBreakdown[];
  topImprovers: { id: string; delta: number }[];
  topDecliners: { id: string; delta: number }[];
}

export interface TierBreakdown {
  tier: string;
  count: number;
  avgScore: number;
  passing: number;
  total: number;
  scores: { id: string; score: number; passing: boolean }[];
}

// ── Overnight Summary ───────────────────────────────────

export interface OvernightSummary {
  startTime: string;
  endTime: string;
  totalRounds: number;
  totalDurationHours: number;
  startingAvg: number;
  endingAvg: number;
  netDelta: number;
  bestRound: { round: number; score: number };
  worstRound: { round: number; score: number };
  totalMutations: number;
  newMutations: string[];
  tokensUsed: number;
  estimatedCost?: number;
  highlights: string[];
  model: string;
  passingAtStart: number;
  passingAtEnd: number;
  totalBenchmarks: number;
}

// ── Alert Types ─────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  severity: AlertSeverity;
  message: string;
  timestamp: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

// ── System Status ───────────────────────────────────────

export interface SystemStatus {
  online: boolean;
  model: string;
  uptime: number;
  currentIteration: number;
  isRunning: boolean;
  lastActivity: string;
  benchmarksPassing: number;
  benchmarksTotal: number;
  avgScore: number;
  mutationCount: number;
  routerState?: string;
}

// ── Command Handler ─────────────────────────────────────

export type CommandHandler = (
  args: string,
  chatId: number,
  bot: any
) => Promise<void>;

export interface CommandDefinition {
  name: string;
  description: string;
  handler: CommandHandler;
}

// ── Bot Config ──────────────────────────────────────────

export interface TelegramBotConfig {
  token: string;
  chatId: string;
  pollingInterval?: number;
  maxMessageLength?: number;
}

// ── Agent Mode Types ────────────────────────────────────

export type AgentActionType =
  | "run_benchmark"
  | "check_status"
  | "search_repos"
  | "get_scores"
  | "compare"
  | "start_competition"
  | "stop_process"
  | "get_mutations"
  | "get_model_info";

export interface AgentAction {
  type: AgentActionType;
  params?: Record<string, any>;
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: any;
}

// ── Memory Types ────────────────────────────────────────

export interface ConversationEntry {
  timestamp: string;
  chatId: string;
  userMessage: string;
  botResponse: string;
}

export interface RepoEntry {
  name: string;
  url?: string;
  description?: string;
  score?: number;
  category?: string;
  addedAt: string;
}

export interface Learning {
  id: string;
  learning: string;
  source: string;
  timestamp: string;
}

export interface BotMemoryData {
  store: Record<string, any>;
  conversations: Record<string, ConversationEntry[]>;
  repos: RepoEntry[];
  learnings: Learning[];
}

// ── Dashboard Types ─────────────────────────────────────

export interface DashboardData {
  roundNumber: number;
  totalRounds: number;
  timestamp: string;
  eightAvg: number;
  claudeAvg: number;
  trend: "improving" | "declining" | "stable";
  progressPercent: number;
  estimatedCompletion?: string;
  topScore?: { name: string; score: number };
  recentDelta?: number;
}
