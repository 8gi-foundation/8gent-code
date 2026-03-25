/**
 * WebhookReceiver - lightweight HTTP server for receiving and validating webhooks.
 *
 * Features:
 * - Configurable port
 * - HMAC-SHA256 signature validation (per-path or global secret)
 * - Path-based routing with typed callbacks
 * - In-memory event queue with configurable max size
 * - Zero external dependencies (Bun.serve + Node crypto)
 */

import { createHmac } from "crypto";

export interface WebhookEvent<T = unknown> {
  id: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  payload: T;
  receivedAt: number;
  validated: boolean;
}

export type WebhookHandler<T = unknown> = (event: WebhookEvent<T>) => void | Promise<void>;

export interface RouteConfig {
  path: string;
  /** HMAC-SHA256 secret. Overrides the global secret for this path. */
  secret?: string;
  /** Header carrying the signature. Default: "x-webhook-signature". */
  signatureHeader?: string;
  handler: WebhookHandler;
}

export interface WebhookReceiverOptions {
  port?: number;
  /** Global HMAC secret used when no per-route secret is set. */
  secret?: string;
  /** Max queued events before oldest are dropped. Default: 1000. */
  maxQueueSize?: number;
  /** If true, requests with invalid or missing signatures are rejected 403. Default: true. */
  enforceSignatures?: boolean;
}

const DEFAULT_PORT = 18791;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_SIG_HEADER = "x-webhook-signature";

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function verifySignature(body: string, secret: string, signature: string): boolean {
  if (!signature) return false;
  // Support "sha256=<hex>" (GitHub style) or raw hex
  const raw = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  if (raw.length !== expected.length) return false;
  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ raw.charCodeAt(i);
  }
  return diff === 0;
}

export class WebhookReceiver {
  private routes = new Map<string, RouteConfig>();
  private queue: WebhookEvent[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly opts: Required<WebhookReceiverOptions>;

  constructor(opts: WebhookReceiverOptions = {}) {
    this.opts = {
      port: opts.port ?? DEFAULT_PORT,
      secret: opts.secret ?? "",
      maxQueueSize: opts.maxQueueSize ?? DEFAULT_MAX_QUEUE,
      enforceSignatures: opts.enforceSignatures ?? true,
    };
  }

  /** Register a path handler. Call before start(). */
  on(config: RouteConfig): this {
    this.routes.set(config.path, config);
    return this;
  }

  /** Start the HTTP server. */
  start(): this {
    const self = this;
    this.server = Bun.serve({
      port: this.opts.port,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const route = self.routes.get(url.pathname);

        if (!route) {
          return new Response("not found", { status: 404 });
        }

        const bodyText = await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });

        const sigHeader = route.signatureHeader ?? DEFAULT_SIG_HEADER;
        const secret = route.secret ?? self.opts.secret;
        const rawSig = headers[sigHeader] ?? "";

        let validated = false;
        if (secret) {
          validated = verifySignature(bodyText, secret, rawSig);
          if (!validated && self.opts.enforceSignatures) {
            return new Response("forbidden: invalid signature", { status: 403 });
          }
        }

        let payload: unknown;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          payload = bodyText;
        }

        const event: WebhookEvent = {
          id: makeId(),
          path: url.pathname,
          method: req.method,
          headers,
          payload,
          receivedAt: Date.now(),
          validated,
        };

        // Enqueue - drop oldest if at capacity
        if (self.queue.length >= self.opts.maxQueueSize) {
          self.queue.shift();
        }
        self.queue.push(event);

        try {
          await route.handler(event);
        } catch (err) {
          console.error(`[WebhookReceiver] handler error on ${url.pathname}:`, err);
        }

        return new Response(JSON.stringify({ received: true, id: event.id }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    return this;
  }

  /** Stop the server and clear state. */
  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  /** Drain all queued events (consume and return). */
  drain(): WebhookEvent[] {
    return this.queue.splice(0);
  }

  /** Peek at queued events without consuming them. */
  peek(): ReadonlyArray<WebhookEvent> {
    return this.queue;
  }

  get port(): number {
    return this.opts.port;
  }
}
