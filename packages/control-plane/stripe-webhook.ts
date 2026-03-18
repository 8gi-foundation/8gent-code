/**
 * @8gent/control-plane — Stripe Webhook Route Handler
 *
 * Framework-agnostic webhook handler that works with Hono, Express, or
 * any framework that provides the raw request body and headers.
 *
 * Usage with Hono:
 *   app.post("/webhooks/stripe", stripeWebhookHandler);
 *
 * Usage with Express:
 *   app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookHandler);
 *
 * IMPORTANT: The webhook endpoint must receive the raw request body (not parsed JSON).
 * For Express, use express.raw() middleware. For Hono, the body is raw by default.
 */

import { handleStripeWebhook } from "./billing";
import type { WebhookResult } from "./billing";

// ============================================
// Hono-compatible handler
// ============================================

/**
 * Stripe webhook handler for Hono.
 *
 * Example:
 * ```ts
 * import { Hono } from "hono";
 * import { createHonoWebhookHandler } from "@8gent/control-plane/stripe-webhook";
 *
 * const app = new Hono();
 * app.post("/webhooks/stripe", createHonoWebhookHandler({
 *   onSubscriptionChange: async (result) => {
 *     // Update your database with new plan
 *     await db.updateUserPlan(result.customerId, result.newPlan);
 *   },
 *   onPaymentFailed: async (result) => {
 *     // Send notification, pause access, etc.
 *     await notifyUser(result.customerId, "Payment failed");
 *   },
 * }));
 * ```
 */
export function createHonoWebhookHandler(callbacks?: WebhookCallbacks) {
  return async (c: HonoContext): Promise<HonoResponse> => {
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "Missing stripe-signature header" }, 400);
    }

    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return c.json({ error: "Failed to read request body" }, 400);
    }

    const result = await handleStripeWebhook(rawBody, signature);

    if (result.error && result.event === "unknown") {
      // Signature verification failed
      return c.json({ error: result.error }, 400);
    }

    // Fire callbacks if provided
    if (callbacks && result.handled) {
      try {
        await dispatchCallbacks(callbacks, result);
      } catch (err) {
        console.error("[stripe-webhook] Callback error:", err);
        // Don't fail the webhook — Stripe will retry
      }
    }

    // Always return 200 to Stripe (even for unhandled events) to prevent retries
    return c.json({ received: true, event: result.event, handled: result.handled }, 200);
  };
}

// ============================================
// Express-compatible handler
// ============================================

/**
 * Stripe webhook handler for Express.
 *
 * IMPORTANT: You must use express.raw() middleware on this route:
 * ```ts
 * import express from "express";
 * import { createExpressWebhookHandler } from "@8gent/control-plane/stripe-webhook";
 *
 * const app = express();
 * app.post("/webhooks/stripe",
 *   express.raw({ type: "application/json" }),
 *   createExpressWebhookHandler({ ... })
 * );
 * ```
 */
export function createExpressWebhookHandler(callbacks?: WebhookCallbacks) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const signature = req.headers["stripe-signature"] as string | undefined;
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }

    // Express with express.raw() gives us a Buffer in req.body
    const rawBody: string | Buffer = typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body
        : JSON.stringify(req.body); // Fallback, but signature verification may fail

    const result = await handleStripeWebhook(rawBody, signature);

    if (result.error && result.event === "unknown") {
      res.status(400).json({ error: result.error });
      return;
    }

    // Fire callbacks if provided
    if (callbacks && result.handled) {
      try {
        await dispatchCallbacks(callbacks, result);
      } catch (err) {
        console.error("[stripe-webhook] Callback error:", err);
      }
    }

    res.status(200).json({ received: true, event: result.event, handled: result.handled });
  };
}

// ============================================
// Generic handler (framework-agnostic)
// ============================================

/**
 * Low-level webhook handler — pass the raw body and signature directly.
 * Use this if your framework isn't Hono or Express.
 */
export async function processStripeWebhook(
  rawBody: string | Buffer,
  signature: string,
  callbacks?: WebhookCallbacks,
): Promise<WebhookResult> {
  const result = await handleStripeWebhook(rawBody, signature);

  if (callbacks && result.handled) {
    try {
      await dispatchCallbacks(callbacks, result);
    } catch (err) {
      console.error("[stripe-webhook] Callback error:", err);
    }
  }

  return result;
}

// ============================================
// Callback Types
// ============================================

/**
 * Callbacks triggered by specific webhook events.
 * All callbacks are optional — implement only what you need.
 */
export interface WebhookCallbacks {
  /** Fired on customer.subscription.created and customer.subscription.updated */
  onSubscriptionChange?: (result: WebhookResult) => Promise<void>;
  /** Fired on customer.subscription.deleted — user should be downgraded to free */
  onSubscriptionDeleted?: (result: WebhookResult) => Promise<void>;
  /** Fired on invoice.paid */
  onPaymentSuccess?: (result: WebhookResult) => Promise<void>;
  /** Fired on invoice.payment_failed */
  onPaymentFailed?: (result: WebhookResult) => Promise<void>;
}

// ============================================
// Internal
// ============================================

async function dispatchCallbacks(callbacks: WebhookCallbacks, result: WebhookResult): Promise<void> {
  switch (result.event) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await callbacks.onSubscriptionChange?.(result);
      break;
    case "customer.subscription.deleted":
      await callbacks.onSubscriptionDeleted?.(result);
      break;
    case "invoice.paid":
      await callbacks.onPaymentSuccess?.(result);
      break;
    case "invoice.payment_failed":
      await callbacks.onPaymentFailed?.(result);
      break;
  }
}

// ============================================
// Minimal type stubs for framework compatibility
// (avoid requiring hono/express as dependencies)
// ============================================

interface HonoContext {
  req: {
    header(name: string): string | undefined;
    text(): Promise<string>;
  };
  json(data: unknown, status?: number): HonoResponse;
}

type HonoResponse = unknown;

interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(data: unknown): void;
}
