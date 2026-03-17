/**
 * @8gent/control-plane — Main Entry Point
 *
 * ControlPlane class aggregates tenant management, analytics, and billing
 * into a single interface for the admin dashboard.
 */

import type {
  AdminDashboard,
  PlanTier,
  TenantConfig,
  UsageReport,
  ReportPeriod,
  SystemHealth,
  UserUsageStats,
  BillableUsage,
} from "./types";

import {
  createTenant,
  getTenantBySubdomain,
  getTenantById,
  listTenants,
  updateTenantPlan,
  deleteTenant,
  checkUsageLimits,
  isFeatureEnabled,
  resolveSubdomain,
} from "./tenant";

import {
  calculateUserGrowth,
  getActiveSessionCount,
  aggregateTokenUsage,
  calculateModelDistribution,
  calculatePlanDistribution,
  generateUsageReport,
  getTopUsers,
  calculateSystemHealth,
} from "./analytics";

import {
  PLAN_DEFINITIONS,
  getPlan,
  checkPlanLimits,
  getUsageForBilling,
  estimateMonthlyRevenue,
  formatCents,
  createStripeCustomer,
  createStripeSubscription,
  cancelStripeSubscription,
  handleStripeWebhook,
  getStripeBillingPortalUrl,
} from "./billing";

// ============================================
// ControlPlane Class
// ============================================

/**
 * Unified control plane interface.
 *
 * Aggregates tenant, analytics, and billing operations.
 * All methods that access cross-tenant data require admin role verification
 * at the caller level (Convex functions or middleware).
 */
export class ControlPlane {
  // ----------------------------------------
  // Tenant Management
  // ----------------------------------------

  createTenant(userId: string, clerkId: string, subdomain: string, plan?: PlanTier): TenantConfig {
    return createTenant(userId, clerkId, subdomain, plan);
  }

  getTenantBySubdomain(subdomain: string): TenantConfig | null {
    return getTenantBySubdomain(subdomain);
  }

  getTenantById(tenantId: string): TenantConfig | null {
    return getTenantById(tenantId);
  }

  listTenants(planFilter?: PlanTier): TenantConfig[] {
    return listTenants(planFilter);
  }

  updateTenantPlan(tenantId: string, plan: PlanTier): TenantConfig {
    return updateTenantPlan(tenantId, plan);
  }

  deleteTenant(tenantId: string): boolean {
    return deleteTenant(tenantId);
  }

  checkUsageLimits(tenantId: string, dailyTokens: number, activeSessions: number) {
    return checkUsageLimits(tenantId, dailyTokens, activeSessions);
  }

  isFeatureEnabled(tenantId: string, feature: Parameters<typeof isFeatureEnabled>[1]): boolean {
    return isFeatureEnabled(tenantId, feature);
  }

  resolveSubdomain(hostname: string): string | null {
    return resolveSubdomain(hostname);
  }

  // ----------------------------------------
  // Analytics
  // ----------------------------------------

  /**
   * Build the complete admin dashboard summary.
   *
   * This is the main method called by the dashboard page.
   * It takes raw data from Convex and computes all derived metrics.
   */
  getAdminDashboard(data: {
    users: Array<{ plan: PlanTier; createdAt: number }>;
    sessions: Array<{ startedAt: number; endedAt?: number; model: string }>;
    usageRecords: Array<{ date: string; tokensIn: number; tokensOut: number }>;
    todayDate: string;
  }): AdminDashboard {
    const { users, sessions, usageRecords, todayDate } = data;

    const planDist = calculatePlanDistribution(users);
    const revenue = estimateMonthlyRevenue(planDist);

    // Tokens consumed today
    const todayRecords = usageRecords.filter((r) => r.date === todayDate);
    let tokensToday = 0;
    for (const r of todayRecords) {
      tokensToday += r.tokensIn + r.tokensOut;
    }

    return {
      userCount: users.length,
      activeSessionCount: getActiveSessionCount(sessions),
      tokensToday,
      estimatedRevenue: revenue,
      userGrowth: calculateUserGrowth(
        users.map((u) => u.createdAt),
        30,
      ),
      tokenUsage: aggregateTokenUsage(usageRecords, 30),
      modelDistribution: calculateModelDistribution(sessions),
      planDistribution: planDist,
    };
  }

  getUsageReport(
    period: ReportPeriod,
    usageRecords: Array<{
      userId: string;
      date: string;
      tokensIn: number;
      tokensOut: number;
      sessions: number;
      models: string[];
    }>,
  ): UsageReport {
    return generateUsageReport(period, usageRecords);
  }

  getTopUsers(
    users: Array<{
      userId: string;
      displayName: string;
      githubUsername: string;
      plan: PlanTier;
      lastActiveAt: number;
    }>,
    usageRecords: Array<{
      userId: string;
      tokensIn: number;
      tokensOut: number;
      sessions: number;
    }>,
    limit?: number,
  ): UserUsageStats[] {
    return getTopUsers(users, usageRecords, limit);
  }

  getSystemHealth(
    sessions: Array<{
      startedAt: number;
      endedAt?: number;
      model: string;
      provider: string;
    }>,
  ): SystemHealth {
    return calculateSystemHealth(sessions);
  }

  // ----------------------------------------
  // Billing
  // ----------------------------------------

  getPlan(tier: PlanTier) {
    return getPlan(tier);
  }

  checkPlanLimits(plan: PlanTier, dailyTokens: number) {
    return checkPlanLimits(plan, dailyTokens);
  }

  getUsageForBilling(
    userId: string,
    plan: PlanTier,
    usageRecords: Array<{
      date: string;
      tokensIn: number;
      tokensOut: number;
      sessions: number;
    }>,
    periodStart: string,
    periodEnd: string,
  ): BillableUsage {
    return getUsageForBilling(userId, plan, usageRecords, periodStart, periodEnd);
  }

  formatCents(cents: number): string {
    return formatCents(cents);
  }

  // Stripe stubs
  async createStripeCustomer(email: string, name: string, metadata: Record<string, string>) {
    return createStripeCustomer(email, name, metadata);
  }

  async createStripeSubscription(customerId: string, priceId: string) {
    return createStripeSubscription(customerId, priceId);
  }

  async cancelStripeSubscription(subscriptionId: string) {
    return cancelStripeSubscription(subscriptionId);
  }

  async handleStripeWebhook(body: string, signature: string) {
    return handleStripeWebhook(body, signature);
  }

  async getStripeBillingPortalUrl(customerId: string, returnUrl: string) {
    return getStripeBillingPortalUrl(customerId, returnUrl);
  }
}

// ============================================
// Singleton + Re-exports
// ============================================

/** Default control plane instance. */
export const controlPlane = new ControlPlane();

export { PLAN_DEFINITIONS } from "./billing";
export type {
  TenantConfig,
  AdminDashboard,
  UsageReport,
  BillingPlan,
  BillableUsage,
  PlanTier,
  PlanLimits,
  TenantFeatures,
  DataPoint,
  ReportPeriod,
  UserUsageStats,
  SystemHealth,
} from "./types";
