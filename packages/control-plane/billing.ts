/**
 * @8gent/control-plane — Billing
 *
 * Plan definitions, usage metering, and real Stripe integration.
 * Free tier works without Stripe — no API key required for local-only users.
 */

import Stripe from "stripe";
import type { BillingPlan, BillableUsage, PlanTier, PlanLimits, TenantFeatures } from "./types";

// ============================================
// Stripe Client (lazy-initialized)
// ============================================

let _stripe: Stripe | null = null;

/**
 * Get the Stripe client instance. Lazily initialized from STRIPE_SECRET_KEY env var.
 * Throws if called without STRIPE_SECRET_KEY set — free tier callers should
 * never reach Stripe functions.
 */
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        "[billing] STRIPE_SECRET_KEY is not set. Stripe operations require a valid API key. " +
        "Free tier users do not need Stripe configured."
      );
    }
    _stripe = new Stripe(key, {
      apiVersion: "2025-03-31.basil",
      typescript: true,
    });
  }
  return _stripe;
}

// ============================================
// Stripe Price ID Constants
// ============================================

/**
 * Stripe Price IDs for each plan tier.
 * REPLACE WITH YOUR STRIPE PRICE IDs after creating products in the Stripe Dashboard.
 *
 * To create these:
 * 1. Go to https://dashboard.stripe.com/products
 * 2. Create a product for each tier (Pro, Team)
 * 3. Add a recurring monthly price to each product
 * 4. Copy the price_xxx IDs here
 */
export const STRIPE_PRICE_IDS: Record<PlanTier, string> = {
  free: "", // Free tier has no Stripe price
  pro: "price_1TCVZJBKd7OmxSCYcZBt9oaO",   // $29/mo — 8gent Pro
  team: "price_1TCVZSBKd7OmxSCYMyaUi2Ii",   // $99/mo — 8gent Team
};

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
    stripePriceId: STRIPE_PRICE_IDS.pro,
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
    stripePriceId: STRIPE_PRICE_IDS.team,
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
// Stripe Integration — Real SDK Calls
// ============================================

/**
 * Create a Stripe customer for a new user.
 * Used when a user signs up or upgrades from free to a paid plan.
 */
export async function createStripeCustomer(
  email: string,
  name: string,
  metadata: Record<string, string>,
): Promise<{ customerId: string }> {
  try {
    const stripe = getStripe();
    const customer = await stripe.customers.create({
      email,
      name,
      metadata,
    });
    console.log(`[billing] Created Stripe customer ${customer.id} for ${email}`);
    return { customerId: customer.id };
  } catch (error) {
    console.error("[billing] Failed to create Stripe customer:", error);
    throw error;
  }
}

/**
 * Create a subscription for a customer.
 * The priceId should come from STRIPE_PRICE_IDS based on the selected plan tier.
 */
export async function createStripeSubscription(
  customerId: string,
  priceId: string,
): Promise<{ subscriptionId: string; status: string; clientSecret: string | null }> {
  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
      },
      expand: ["latest_invoice.payment_intent"],
    });

    // Extract client secret for frontend payment confirmation if needed
    let clientSecret: string | null = null;
    const invoice = subscription.latest_invoice;
    if (invoice && typeof invoice !== "string") {
      const paymentIntent = invoice.payment_intent;
      if (paymentIntent && typeof paymentIntent !== "string") {
        clientSecret = paymentIntent.client_secret;
      }
    }

    console.log(`[billing] Created subscription ${subscription.id} for customer ${customerId}`);
    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      clientSecret,
    };
  } catch (error) {
    console.error("[billing] Failed to create subscription:", error);
    throw error;
  }
}

/**
 * Cancel a subscription at the end of the current billing period.
 * Does not immediately cancel — the user retains access until period end.
 */
export async function cancelStripeSubscription(
  subscriptionId: string,
): Promise<{ status: string; cancelAt: number | null }> {
  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    console.log(`[billing] Scheduled cancellation for subscription ${subscriptionId}`);
    return {
      status: subscription.status,
      cancelAt: subscription.cancel_at,
    };
  } catch (error) {
    console.error("[billing] Failed to cancel subscription:", error);
    throw error;
  }
}

/**
 * Immediately cancel a subscription (no grace period).
 * Use sparingly — prefer cancelStripeSubscription() for user-initiated cancellations.
 */
export async function cancelStripeSubscriptionImmediately(
  subscriptionId: string,
): Promise<{ status: string }> {
  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.cancel(subscriptionId);

    console.log(`[billing] Immediately canceled subscription ${subscriptionId}`);
    return { status: subscription.status };
  } catch (error) {
    console.error("[billing] Failed to immediately cancel subscription:", error);
    throw error;
  }
}

/**
 * Webhook event handler result type.
 */
export interface WebhookResult {
  handled: boolean;
  event: string;
  customerId?: string;
  subscriptionId?: string;
  newPlan?: PlanTier;
  error?: string;
}

/**
 * Handle Stripe webhook events.
 * Verifies the signature and processes relevant subscription/invoice events.
 *
 * The caller is responsible for:
 * 1. Passing the raw request body (as string/Buffer) and the Stripe-Signature header
 * 2. Updating the tenant database based on the returned WebhookResult
 */
export async function handleStripeWebhook(
  body: string | Buffer,
  signature: string,
): Promise<WebhookResult> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[billing] STRIPE_WEBHOOK_SECRET is not set — cannot verify webhook");
    return { handled: false, event: "unknown", error: "STRIPE_WEBHOOK_SECRET not configured" };
  }

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown verification error";
    console.error(`[billing] Webhook signature verification failed: ${message}`);
    return { handled: false, event: "unknown", error: `Signature verification failed: ${message}` };
  }

  console.log(`[billing] Processing webhook event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      // ---- Subscription lifecycle ----
      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        const tier = resolvePlanTierFromSubscription(subscription);
        console.log(`[billing] Subscription created: ${subscription.id}, tier: ${tier}`);
        return {
          handled: true,
          event: event.type,
          customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
          subscriptionId: subscription.id,
          newPlan: tier,
        };
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const tier = resolvePlanTierFromSubscription(subscription);

        // Check if subscription was effectively canceled
        if (subscription.cancel_at_period_end) {
          console.log(`[billing] Subscription ${subscription.id} scheduled for cancellation`);
        } else {
          console.log(`[billing] Subscription updated: ${subscription.id}, tier: ${tier}`);
        }

        return {
          handled: true,
          event: event.type,
          customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
          subscriptionId: subscription.id,
          newPlan: tier,
        };
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        console.log(`[billing] Subscription deleted: ${subscription.id} — downgrading to free`);
        return {
          handled: true,
          event: event.type,
          customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
          subscriptionId: subscription.id,
          newPlan: "free",
        };
      }

      // ---- Invoice / payment events ----
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        console.log(`[billing] Invoice paid: ${invoice.id}, amount: ${invoice.amount_paid}`);
        return {
          handled: true,
          event: event.type,
          customerId: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
          subscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id,
        };
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        console.error(`[billing] Payment failed for invoice ${invoice.id}, customer: ${typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id}`);
        return {
          handled: true,
          event: event.type,
          customerId: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
          subscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id,
          error: "Payment failed",
        };
      }

      default:
        console.log(`[billing] Unhandled webhook event type: ${event.type}`);
        return { handled: false, event: event.type };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown processing error";
    console.error(`[billing] Error processing webhook event ${event.type}: ${message}`);
    return { handled: false, event: event.type, error: message };
  }
}

/**
 * Get the Stripe billing portal URL for a customer.
 * Opens a hosted page where the customer can manage payment methods,
 * view invoices, and update/cancel their subscription.
 */
export async function getStripeBillingPortalUrl(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  try {
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  } catch (error) {
    console.error("[billing] Failed to create billing portal session:", error);
    throw error;
  }
}

/**
 * Retrieve a Stripe customer by ID.
 * Useful for checking if a customer already exists before creating a new one.
 */
export async function getStripeCustomer(
  customerId: string,
): Promise<Stripe.Customer | null> {
  try {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    return customer as Stripe.Customer;
  } catch (error) {
    console.error("[billing] Failed to retrieve customer:", error);
    return null;
  }
}

/**
 * Retrieve a Stripe subscription by ID.
 */
export async function getStripeSubscription(
  subscriptionId: string,
): Promise<Stripe.Subscription | null> {
  try {
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return subscription;
  } catch (error) {
    console.error("[billing] Failed to retrieve subscription:", error);
    return null;
  }
}

// ============================================
// Internal Helpers
// ============================================

/**
 * Resolve the PlanTier from a Stripe subscription's price ID.
 * Falls back to "free" if the price ID is not recognized.
 */
function resolvePlanTierFromSubscription(subscription: Stripe.Subscription): PlanTier {
  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) return "free";

  for (const [tier, id] of Object.entries(STRIPE_PRICE_IDS)) {
    if (id && id === priceId) return tier as PlanTier;
  }

  // Check plan metadata as fallback
  const tierMeta = subscription.metadata?.plan_tier;
  if (tierMeta && (tierMeta === "pro" || tierMeta === "team")) {
    return tierMeta;
  }

  console.warn(`[billing] Unknown price ID ${priceId} — defaulting to free`);
  return "free";
}
