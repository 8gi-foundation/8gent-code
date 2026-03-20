import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.join(import.meta.dir, "../../autoresearch/work");

// Dynamic imports from generated code
let router: any, middleware: any, cache: any, transformer: any, gateway: any;

beforeEach(async () => {
  try {
    router = await import(path.join(WORK_DIR, "router.ts"));
  } catch { try { router = await import(path.join(WORK_DIR, "router.js")); } catch {} }
  try {
    middleware = await import(path.join(WORK_DIR, "middleware.ts"));
  } catch { try { middleware = await import(path.join(WORK_DIR, "middleware.js")); } catch {} }
  try {
    cache = await import(path.join(WORK_DIR, "cache.ts"));
  } catch { try { cache = await import(path.join(WORK_DIR, "cache.js")); } catch {} }
  try {
    transformer = await import(path.join(WORK_DIR, "transformer.ts"));
  } catch { try { transformer = await import(path.join(WORK_DIR, "transformer.js")); } catch {} }
  try {
    gateway = await import(path.join(WORK_DIR, "gateway.ts"));
  } catch { try { gateway = await import(path.join(WORK_DIR, "gateway.js")); } catch {} }
});

// ── Router ──────────────────────────────────────────

describe("Router", () => {
  it("matches exact paths", () => {
    const R = router.Router || router.default?.Router || router.default;
    const r = new R();
    const handler = async () => {};
    r.route("GET", "/users", handler);
    const match = r.match("GET", "/users");
    expect(match).not.toBeNull();
    expect(match.handler).toBe(handler);
  });

  it("extracts path params (:id)", () => {
    const R = router.Router || router.default?.Router || router.default;
    const r = new R();
    r.route("GET", "/users/:id", async () => {});
    const match = r.match("GET", "/users/42");
    expect(match).not.toBeNull();
    expect(match.params.id).toBe("42");
  });

  it("handles wildcards", () => {
    const R = router.Router || router.default?.Router || router.default;
    const r = new R();
    const handler = async () => {};
    r.route("GET", "/api/*", handler);
    const match = r.match("GET", "/api/v1/users/list");
    expect(match).not.toBeNull();
    expect(match.handler).toBe(handler);
  });

  it("parses query strings", () => {
    const R = router.Router || router.default?.Router || router.default;
    const r = new R();
    r.route("GET", "/search", async () => {});
    const match = r.match("GET", "/search?q=foo&page=2");
    expect(match).not.toBeNull();
    expect(match.query.q).toBe("foo");
    expect(match.query.page).toBe("2");
  });

  it("returns null for no match", () => {
    const R = router.Router || router.default?.Router || router.default;
    const r = new R();
    r.route("GET", "/users", async () => {});
    const match = r.match("GET", "/posts");
    expect(match).toBeNull();
  });

  it("method matching is case-insensitive", () => {
    const R = router.Router || router.default?.Router || router.default;
    const r = new R();
    r.route("GET", "/test", async () => {});
    expect(r.match("get", "/test")).not.toBeNull();
    expect(r.match("Get", "/test")).not.toBeNull();
  });
});

// ── Middleware Pipeline ─────────────────────────────

describe("MiddlewarePipeline", () => {
  it("executes middlewares in order", async () => {
    const MP = middleware.MiddlewarePipeline || middleware.default?.MiddlewarePipeline || middleware.default;
    const pipeline = new MP();
    const order: number[] = [];
    pipeline.use(async (_req: any, _res: any, next: any) => { order.push(1); await next(); });
    pipeline.use(async (_req: any, _res: any, next: any) => { order.push(2); await next(); });
    pipeline.use(async (_req: any, _res: any, next: any) => { order.push(3); await next(); });
    const req = { method: "GET", path: "/test", headers: {} };
    const res = { status: 200, headers: {} as Record<string, string>, body: "" };
    await pipeline.execute(req, res);
    expect(order).toEqual([1, 2, 3]);
  });

  it("middleware can short-circuit (not call next)", async () => {
    const MP = middleware.MiddlewarePipeline || middleware.default?.MiddlewarePipeline || middleware.default;
    const pipeline = new MP();
    let reachedSecond = false;
    pipeline.use(async (_req: any, res: any, _next: any) => {
      // Don't call next — short circuit
      res.status = 401;
      res.body = "Unauthorized";
    });
    pipeline.use(async (_req: any, _res: any, next: any) => {
      reachedSecond = true;
      await next();
    });
    const req = { method: "GET", path: "/test", headers: {} };
    const res = { status: 200, headers: {} as Record<string, string>, body: "" };
    await pipeline.execute(req, res);
    expect(reachedSecond).toBe(false);
    expect(res.status).toBe(401);
  });
});

// ── CORS Middleware ──────────────────────────────────

describe("CORS Middleware", () => {
  it("corsMiddleware sets CORS headers", async () => {
    const corsFn = middleware.corsMiddleware || middleware.default?.corsMiddleware;
    const cors = corsFn();
    const req = { method: "GET", path: "/test", headers: { origin: "http://example.com" } };
    const res = { status: 200, headers: {} as Record<string, string>, body: "" };
    await cors(req, res, async () => {});
    // Should set access-control-allow-origin or similar
    const headerKeys = Object.keys(res.headers).map(k => k.toLowerCase());
    const hasCorsHeader = headerKeys.some(k =>
      k.includes("access-control") || k.includes("cors")
    );
    expect(hasCorsHeader).toBe(true);
  });
});

// ── Response Cache ──────────────────────────────────

describe("ResponseCache", () => {
  it("get/set with TTL", async () => {
    const RC = cache.ResponseCache || cache.default?.ResponseCache || cache.default;
    const c = new RC({ maxSize: 10, defaultTTL: 5000 });
    const response = { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}', cachedAt: Date.now(), ttl: 5000 };
    c.set("key1", response);
    const result = c.get("key1");
    expect(result).not.toBeNull();
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it("TTL expiration works", async () => {
    const RC = cache.ResponseCache || cache.default?.ResponseCache || cache.default;
    const c = new RC({ maxSize: 10, defaultTTL: 50 });
    const response = { status: 200, headers: {}, body: "data", cachedAt: Date.now(), ttl: 50 };
    c.set("expire-key", response, 50);
    // Should exist immediately
    expect(c.get("expire-key")).not.toBeNull();
    // Wait for expiration
    await new Promise(r => setTimeout(r, 80));
    expect(c.get("expire-key")).toBeNull();
  });

  it("LRU eviction when cache is full", () => {
    const RC = cache.ResponseCache || cache.default?.ResponseCache || cache.default;
    const c = new RC({ maxSize: 2, defaultTTL: 60000 });
    c.set("a", { status: 200, headers: {}, body: "a", cachedAt: Date.now(), ttl: 60000 });
    c.set("b", { status: 200, headers: {}, body: "b", cachedAt: Date.now(), ttl: 60000 });
    // Access "a" to make it recently used
    c.get("a");
    // Add "c" — should evict "b" (least recently used)
    c.set("c", { status: 200, headers: {}, body: "c", cachedAt: Date.now(), ttl: 60000 });
    expect(c.get("a")).not.toBeNull();
    expect(c.get("c")).not.toBeNull();
    expect(c.get("b")).toBeNull();
  });

  it("invalidate by pattern", () => {
    const RC = cache.ResponseCache || cache.default?.ResponseCache || cache.default;
    const c = new RC({ maxSize: 10, defaultTTL: 60000 });
    c.set("/api/users/1", { status: 200, headers: {}, body: "u1", cachedAt: Date.now(), ttl: 60000 });
    c.set("/api/users/2", { status: 200, headers: {}, body: "u2", cachedAt: Date.now(), ttl: 60000 });
    c.set("/api/posts/1", { status: 200, headers: {}, body: "p1", cachedAt: Date.now(), ttl: 60000 });
    const count = c.invalidate("/api/users");
    expect(count).toBeGreaterThanOrEqual(2);
    expect(c.get("/api/users/1")).toBeNull();
    expect(c.get("/api/users/2")).toBeNull();
    expect(c.get("/api/posts/1")).not.toBeNull();
  });
});

// ── Request Transformer ─────────────────────────────

describe("RequestTransformer", () => {
  it("adds and removes headers", () => {
    const RT = transformer.RequestTransformer || transformer.default?.RequestTransformer || transformer.default;
    const t = new RT();
    const transformed = t
      .addHeader("X-Custom", "value")
      .removeHeader("Authorization")
      .apply({ method: "GET", path: "/test", headers: { Authorization: "Bearer token", Accept: "application/json" } });
    expect(transformed.headers["X-Custom"] || transformed.headers["x-custom"]).toBe("value");
    // Authorization should be removed (case-insensitive check)
    const hasAuth = Object.keys(transformed.headers).some(k => k.toLowerCase() === "authorization");
    expect(hasAuth).toBe(false);
  });

  it("rewrites paths", () => {
    const RT = transformer.RequestTransformer || transformer.default?.RequestTransformer || transformer.default;
    const t = new RT();
    const transformed = t
      .rewritePath(/^\/api\/v1\/(.*)/, "/v2/$1")
      .apply({ method: "GET", path: "/api/v1/users", headers: {} });
    expect(transformed.path).toBe("/v2/users");
  });
});

// ── API Gateway ─────────────────────────────────────

describe("APIGateway", () => {
  it("routes requests to handlers", async () => {
    const GW = gateway.APIGateway || gateway.default?.APIGateway || gateway.default;
    const gw = new GW();
    gw.route("GET", "/hello", async (req: any, res: any) => {
      res.status = 200;
      res.body = "Hello, World!";
    });
    const response = await gw.handleRequest({
      method: "GET",
      path: "/hello",
      headers: {},
    });
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    expect(response.body).toContain("Hello");
  });

  it("applies middleware pipeline", async () => {
    const GW = gateway.APIGateway || gateway.default?.APIGateway || gateway.default;
    const gw = new GW();
    let middlewareRan = false;
    gw.use(async (req: any, res: any, next: any) => {
      middlewareRan = true;
      res.headers["X-Middleware"] = "applied";
      await next();
    });
    gw.route("GET", "/test", async (req: any, res: any) => {
      res.status = 200;
      res.body = "ok";
    });
    const response = await gw.handleRequest({
      method: "GET",
      path: "/test",
      headers: {},
    });
    expect(middlewareRan).toBe(true);
    expect(response.headers["X-Middleware"] || response.headers["x-middleware"]).toBe("applied");
  });

  it("returns 404 for unknown routes", async () => {
    const GW = gateway.APIGateway || gateway.default?.APIGateway || gateway.default;
    const gw = new GW();
    gw.route("GET", "/exists", async (req: any, res: any) => { res.status = 200; res.body = "ok"; });
    const response = await gw.handleRequest({
      method: "GET",
      path: "/does-not-exist",
      headers: {},
    });
    expect(response.status).toBe(404);
  });
});
