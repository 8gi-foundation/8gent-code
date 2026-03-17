/**
 * @8gent/control-plane — Billing
 *
 * Plan definitions, usage metering, and Stripe integration stubs.
 * Full Stripe integration will be implemented in a later phase.
 */

import type { BillingPlan, BillableUsage, PlanTier, PlanLimits, TenantFeatures } from "./types";

// ============================================
// Plan Definitions
// ============================================

export const PLAN_DEFINITIONS: Record<PlanTier, BillingPlan> = {
  free: {
    tier: "free",
    name: "Free",
    priceMonthly: 0,
    limits: {
      tokensPerDay: 10_000,
      maxConcurrentSessions: 1,
      maxTeamMembers: 1,
      loraEnabled: false,
    },
    features: {
      customModels: false,
      priorityQueue: false,
      benchmarks: false,
      apiAccess: false,
    },
    stripePriceId: "",
  },
  pro: {
    tier: "pro",
    name: "Pro",
    priceMonthly: 2900, // $29.00
    limits: {
      tokensPerDay: -1, // unlimited
      maxConcurrentSessions: 5,
      maxTeamMembers: 1,
      loraEnabled: true,
    },
    features: {
      customModels: true,
      priorityQueue: true,
      benchmarks: true,
      apiAccess: true,
    },
    stripePriceId: "price_pro_monthly", // placeholder
  },
  team: {
    tier: "team",
    name: "Team",
    priceMonthly: 9900, // $99.00
    limits: {
      tokensPerDay: -1, // unlimited
      maxConcurrentSessions: -1, // unlimited
      maxTeamMembers: 25,
      loraEnabled: true,
    },
    features: {
      customModels: true,
      priorityQueue: true,
      benchmarks: true,
      apiAccess: true,
    },
    stripePriceId: "price_team_monthly", // placeholder
  },
};

// ============================================
// Plan Helpers
// ============================================

/**
 * Get the plan definition for a given tier.
 */
export function getPlan(tier: PlanTier): BillingPlan {
  return PLAN_DEFINITIONS[tier];
}

/**
 * Get limits for a plan tier.
 */
export function getPlanLimits(tier: PlanTier): PlanLimits {
  return PLAN_DEFINITIONS[tier].limits;
}

/**
 * Get features for a plan tier.
 */
export function getPlanFeatures(tier: PlanTier): TenantFeatures {
  return PLAN_DEFINITIONS[tier].features;
}

/**
 * Check if a user's daily token usage is within their plan limits.
 */
export function checkPlanLimits(
  plan: PlanTier,
  currentDailyTokens: number,
): { within: boolean; usage: number; limit: number; percentUsed: number } {
  const limits = PLAN_DEFINITIONS[plan].limits;

  if (limits.tokensPerDay === -1) {
    return { within: true, usage: currentDailyTokens, limit: -1, percentUsed: 0 };
  }

  const percentUsed = (currentDailyTokens / limits.tokensPerDay) * 100;
  return {
    within: currentDailyTokens < limits.tokensPerDay,
    usage: currentDailyTokens,
    limit: limits.tokensPerDay,
    percentUsed: Math.min(percentUsed, 100),
  };
}

// ============================================
// Usage Metering for Billing
// ============================================

/**
 * Calculate billable usage for a user over a billing period.
 */
export function getUsageForBilling(
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
  // Filter to billing period
  const periodRecords = usageRecords.filter(
    (r) => r.date >= periodStart && r.date <= periodEnd,
  );

  let totalTokens = 0;
  let totalSessions = 0;

  for (const record of periodRecords) {
    totalTokens += record.tokensIn + record.tokensOut;
    totalSessions += record.sessions;
  }

  const planDef = PLAN_DEFINITIONS[plan];

  return {
    userId,
    periodStart,
    periodEnd,
    totalTokens,
    totalSessions,
    plan,
    estimatedChargeCents: planDef.priceMonthly,
  };
}

/**
 * Estimate monthly revenue based on current user plan distribution.
 */
export function estimateMonthlyRevenue(
  planDistribution: Record<PlanTier, number>,
): number {
  let total = 0;
  for (const [tier, count] of Object.entries(planDistribution)) {
    total += PLAN_DEFINITIONS[tier as PlanTier].priceMonthly * count;
  }
  return total;
}

/**
 * Format a cent amount as a dollar string.
 */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ============================================
// Stripe Integration Stubs
// ============================================

/**
 * Create a Stripe customer for a new user.
 * Stub — will integrate with Stripe SDK in Phase 6.
 */
export async function createStripeCustomer(
  email: string,
  name: string,
  metadata: Record<string, string>,
): Promise<{ customerId: string }> {
  // TODO: Integrate with Stripe SDK
  // const customer = await stripe.customers.create({ email, name, metadata });
  console.log(`[billing] Stripe stub: createCustomer for ${email}`);
  return { customerId: `cus_stub_${Date.now()}` };
}

/**
 * Create a subscription for a customer.
 * Stub — will integrate with Stripe SDK in Phase 6.
 */
export async function createStripeSubscription(
  customerId: string,
  priceId: string,
): Promise<{ subscriptionId: string; status: string }> {
  // TODO: Integrate with Stripe SDK
  // const subscription = await stripe.subscriptions.create({ customer, items: [{ price }] });
  console.log(`[billing] Stripe stub: createSubscription for ${customerId} with ${priceId}`);
  return { subscriptionId: `sub_stub_${Date.now()}`, status: "active" };
}

/**
 * Cancel a subscription.
 * Stub — will integrate with Stripe SDK in Phase 6.
 */
export async function cancelStripeSubscription(
  subscriptionId: string,
): Promise<{ status: string }> {
  // TODO: Integrate with Stripe SDK
  console.log(`[billing] Stripe stub: cancelSubscription ${subscriptionId}`);
  return { status: "canceled" };
}

/**
 * Handle Stripe webhook events.
 * Stub — will implement webhook verification and event handling in Phase 6.
 */
export async function handleStripeWebhook(
  body: string,
  signature: string,
): Promise<{ handled: boolean; event?: string }> {
  // TODO: Integrate with Stripe SDK
  // const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  console.log("[billing] Stripe stub: webhook received");
  return { handled: false, event: "stub" };
}

/**
 * Get the Stripe billing portal URL for a customer.
 * Stub — will integrate with Stripe SDK in Phase 6.
 */
export async function getStripeBillingPortalUrl(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  // TODO: Integrate with Stripe SDK
  console.log(`[billing] Stripe stub: billingPortal for ${customerId}`);
  return `${returnUrl}?stub=true`;
}
