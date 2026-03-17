/**
 * @8gent/control-plane — Type Definitions
 *
 * Types for multi-tenant control plane: tenant config, admin dashboard,
 * usage reporting, and billing plans.
 */

// ============================================
// Tenant Configuration
// ============================================

export type PlanTier = "free" | "pro" | "team";

export interface TenantConfig {
  /** Internal tenant ID (matches Convex user _id). */
  tenantId: string;
  /** Clerk user ID. */
  clerkId: string;
  /** Subdomain slug (e.g., "james" for james.8gent.app). */
  subdomain: string;
  /** Current billing plan. */
  plan: PlanTier;
  /** Usage limits for the current plan. */
  limits: PlanLimits;
  /** Feature flags for this tenant. */
  features: TenantFeatures;
  /** Tenant creation timestamp (Unix ms). */
  createdAt: number;
}

export interface PlanLimits {
  /** Max tokens per day (input + output combined). -1 = unlimited. */
  tokensPerDay: number;
  /** Max concurrent sessions. -1 = unlimited. */
  maxConcurrentSessions: number;
  /** Max team members (only relevant for team plan). */
  maxTeamMembers: number;
  /** Whether LoRA fine-tuning is available. */
  loraEnabled: boolean;
}

export interface TenantFeatures {
  /** Custom model routing enabled. */
  customModels: boolean;
  /** Priority queue for model inference. */
  priorityQueue: boolean;
  /** Access to benchmark suite. */
  benchmarks: boolean;
  /** API access (programmatic usage). */
  apiAccess: boolean;
}

// ============================================
// Admin Dashboard
// ============================================

export interface AdminDashboard {
  /** Total registered users. */
  userCount: number;
  /** Currently active sessions (no endedAt). */
  activeSessionCount: number;
  /** Total tokens consumed today (in + out). */
  tokensToday: number;
  /** Estimated monthly revenue based on current subscriptions. */
  estimatedRevenue: number;
  /** User growth data points (last 30 days). */
  userGrowth: DataPoint[];
  /** Token usage data points (last 30 days). */
  tokenUsage: DataPoint[];
  /** Distribution of models used. */
  modelDistribution: Record<string, number>;
  /** Plan distribution across users. */
  planDistribution: Record<PlanTier, number>;
}

export interface DataPoint {
  /** Date string (YYYY-MM-DD). */
  date: string;
  /** Numeric value for this data point. */
  value: number;
}

// ============================================
// Usage Reporting
// ============================================

export type ReportPeriod = "daily" | "weekly" | "monthly";

export interface UsageReport {
  /** Reporting period. */
  period: ReportPeriod;
  /** Start date (YYYY-MM-DD). */
  startDate: string;
  /** End date (YYYY-MM-DD). */
  endDate: string;
  /** Total tokens (in + out) for the period. */
  totalTokens: number;
  /** Total sessions for the period. */
  totalSessions: number;
  /** Unique active users for the period. */
  activeUsers: number;
  /** Daily breakdown. */
  daily: DataPoint[];
  /** Per-model breakdown. */
  byModel: Record<string, number>;
}

export interface UserUsageStats {
  /** User ID. */
  userId: string;
  /** Display name. */
  displayName: string;
  /** GitHub username. */
  githubUsername: string;
  /** Current plan. */
  plan: PlanTier;
  /** Total tokens consumed in the period. */
  totalTokens: number;
  /** Total sessions in the period. */
  totalSessions: number;
  /** Last active timestamp. */
  lastActiveAt: number;
}

// ============================================
// Billing Plans
// ============================================

export interface BillingPlan {
  /** Plan identifier. */
  tier: PlanTier;
  /** Display name. */
  name: string;
  /** Monthly price in cents (0 for free). */
  priceMonthly: number;
  /** Usage limits. */
  limits: PlanLimits;
  /** Features included. */
  features: TenantFeatures;
  /** Stripe price ID (empty for free tier). */
  stripePriceId: string;
}

export interface BillableUsage {
  /** User ID. */
  userId: string;
  /** Billing period start (YYYY-MM-DD). */
  periodStart: string;
  /** Billing period end (YYYY-MM-DD). */
  periodEnd: string;
  /** Total tokens consumed. */
  totalTokens: number;
  /** Total sessions. */
  totalSessions: number;
  /** Current plan. */
  plan: PlanTier;
  /** Estimated charge in cents. */
  estimatedChargeCents: number;
}

// ============================================
// System Health
// ============================================

export interface SystemHealth {
  /** Active session count. */
  activeSessions: number;
  /** Sessions started in the last hour. */
  sessionsLastHour: number;
  /** Error rate (sessions that crashed / total). */
  errorRate: number;
  /** Model distribution (model name -> session count). */
  modelDistribution: Record<string, number>;
  /** Provider distribution. */
  providerDistribution: Record<string, number>;
  /** Average session duration in ms. */
  avgSessionDuration: number;
}
