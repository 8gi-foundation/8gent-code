import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

// Dynamic imports from generated code
let auth: any, rbac: any, rateLimiter: any, userStore: any;

beforeEach(async () => {
  try {
    auth = await import(path.join(WORK_DIR, "auth.ts"));
    rbac = await import(path.join(WORK_DIR, "rbac.ts"));
    rateLimiter = await import(path.join(WORK_DIR, "rate-limiter.ts"));
    userStore = await import(path.join(WORK_DIR, "user-store.ts"));
  } catch (e: any) {
    // Try alternate names
    try { auth = await import(path.join(WORK_DIR, "auth.js")); } catch {}
    try { rbac = await import(path.join(WORK_DIR, "rbac.js")); } catch {}
    try { rateLimiter = await import(path.join(WORK_DIR, "rate-limiter.js")); } catch {}
    try { userStore = await import(path.join(WORK_DIR, "user-store.js")); } catch {}
  }
});

// ── Password Hashing ─────────────────────────────────

describe("Password Hashing", () => {
  it("hashPassword returns a string different from input", async () => {
    const hash = await (auth.hashPassword || auth.default?.hashPassword)("mypassword123");
    expect(typeof hash).toBe("string");
    expect(hash).not.toBe("mypassword123");
    expect(hash.length).toBeGreaterThan(10);
  });

  it("verifyPassword returns true for correct password", async () => {
    const hashFn = auth.hashPassword || auth.default?.hashPassword;
    const verifyFn = auth.verifyPassword || auth.default?.verifyPassword;
    const hash = await hashFn("secretpass");
    const result = await verifyFn("secretpass", hash);
    expect(result).toBe(true);
  });

  it("verifyPassword returns false for wrong password", async () => {
    const hashFn = auth.hashPassword || auth.default?.hashPassword;
    const verifyFn = auth.verifyPassword || auth.default?.verifyPassword;
    const hash = await hashFn("secretpass");
    const result = await verifyFn("wrongpass", hash);
    expect(result).toBe(false);
  });

  it("different passwords produce different hashes", async () => {
    const hashFn = auth.hashPassword || auth.default?.hashPassword;
    const h1 = await hashFn("password1");
    const h2 = await hashFn("password2");
    expect(h1).not.toBe(h2);
  });
});

// ── JWT Tokens ───────────────────────────────────────

describe("Token Generation", () => {
  const SECRET = "test-secret-key-12345";

  it("generateToken returns a string with 3 parts", () => {
    const genFn = auth.generateToken || auth.default?.generateToken;
    const token = genFn({ userId: "u1", role: "admin", email: "a@b.com" }, SECRET);
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3);
  });

  it("verifyToken returns payload for valid token", () => {
    const genFn = auth.generateToken || auth.default?.generateToken;
    const verifyFn = auth.verifyToken || auth.default?.verifyToken;
    const token = genFn({ userId: "u1", role: "admin", email: "a@b.com" }, SECRET);
    const payload = verifyFn(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload.userId).toBe("u1");
    expect(payload.role).toBe("admin");
    expect(payload.email).toBe("a@b.com");
  });

  it("verifyToken returns null for wrong secret", () => {
    const genFn = auth.generateToken || auth.default?.generateToken;
    const verifyFn = auth.verifyToken || auth.default?.verifyToken;
    const token = genFn({ userId: "u1", role: "admin", email: "a@b.com" }, SECRET);
    const result = verifyFn(token, "wrong-secret");
    expect(result).toBeNull();
  });

  it("verifyToken returns null for expired token", () => {
    const genFn = auth.generateToken || auth.default?.generateToken;
    const verifyFn = auth.verifyToken || auth.default?.verifyToken;
    const token = genFn({ userId: "u1", role: "admin", email: "a@b.com" }, SECRET, -1000); // expired 1s ago
    const result = verifyFn(token, SECRET);
    expect(result).toBeNull();
  });

  it("generateRefreshToken returns 64+ char hex string", () => {
    const fn = auth.generateRefreshToken || auth.default?.generateRefreshToken;
    const token = fn();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(/^[0-9a-f]+$/i.test(token)).toBe(true);
  });

  it("generateResetCode returns 6-digit string", () => {
    const fn = auth.generateResetCode || auth.default?.generateResetCode;
    const code = fn();
    expect(typeof code).toBe("string");
    expect(code.length).toBe(6);
    expect(/^\d{6}$/.test(code)).toBe(true);
  });
});

// ── RBAC ─────────────────────────────────────────────

describe("RBAC", () => {
  it("admin has all permissions", () => {
    const fn = rbac.hasPermission || rbac.default?.hasPermission;
    expect(fn("admin", "read")).toBe(true);
    expect(fn("admin", "write")).toBe(true);
    expect(fn("admin", "delete")).toBe(true);
    expect(fn("admin", "manage_users")).toBe(true);
    expect(fn("admin", "manage_billing")).toBe(true);
  });

  it("viewer can only read", () => {
    const fn = rbac.hasPermission || rbac.default?.hasPermission;
    expect(fn("viewer", "read")).toBe(true);
    expect(fn("viewer", "write")).toBe(false);
    expect(fn("viewer", "delete")).toBe(false);
    expect(fn("viewer", "manage_users")).toBe(false);
  });

  it("editor can read, write, and view analytics", () => {
    const fn = rbac.hasPermission || rbac.default?.hasPermission;
    expect(fn("editor", "read")).toBe(true);
    expect(fn("editor", "write")).toBe(true);
    expect(fn("editor", "view_analytics")).toBe(true);
    expect(fn("editor", "manage_users")).toBe(false);
  });

  it("billing can read and manage billing", () => {
    const fn = rbac.hasPermission || rbac.default?.hasPermission;
    expect(fn("billing", "read")).toBe(true);
    expect(fn("billing", "manage_billing")).toBe(true);
    expect(fn("billing", "write")).toBe(false);
    expect(fn("billing", "delete")).toBe(false);
  });
});

// ── Rate Limiter ─────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests under limit", () => {
    const RL = rateLimiter.RateLimiter || rateLimiter.default;
    const limiter = new RL(5, 60000);
    const result = limiter.check("user1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("blocks requests over limit", () => {
    const RL = rateLimiter.RateLimiter || rateLimiter.default;
    const limiter = new RL(3, 60000);
    limiter.check("user1");
    limiter.check("user1");
    limiter.check("user1");
    const result = limiter.check("user1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("tracks per-key independently", () => {
    const RL = rateLimiter.RateLimiter || rateLimiter.default;
    const limiter = new RL(2, 60000);
    limiter.check("user1");
    limiter.check("user1");
    const r1 = limiter.check("user1");
    const r2 = limiter.check("user2");
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(true);
  });

  it("reset clears a key", () => {
    const RL = rateLimiter.RateLimiter || rateLimiter.default;
    const limiter = new RL(1, 60000);
    limiter.check("user1");
    limiter.reset("user1");
    const result = limiter.check("user1");
    expect(result.allowed).toBe(true);
  });
});

// ── UserStore ────────────────────────────────────────

describe("UserStore", () => {
  it("creates a user with hashed password", async () => {
    const US = userStore.UserStore || userStore.default;
    const store = new US();
    const user = await store.createUser("test@example.com", "password123");
    expect(user.email).toBe("test@example.com");
    expect(user.passwordHash).not.toBe("password123");
    expect(user.id).toBeDefined();
    expect(user.role).toBeDefined();
  });

  it("findByEmail returns the created user", async () => {
    const US = userStore.UserStore || userStore.default;
    const store = new US();
    await store.createUser("find@test.com", "pass");
    const found = await store.findByEmail("find@test.com");
    expect(found).not.toBeNull();
    expect(found.email).toBe("find@test.com");
  });

  it("findByEmail returns null for unknown email", async () => {
    const US = userStore.UserStore || userStore.default;
    const store = new US();
    const found = await store.findByEmail("unknown@test.com");
    expect(found).toBeNull();
  });

  it("throws on duplicate email", async () => {
    const US = userStore.UserStore || userStore.default;
    const store = new US();
    await store.createUser("dup@test.com", "pass");
    try {
      await store.createUser("dup@test.com", "pass2");
      expect(true).toBe(false); // should not reach here
    } catch (e: any) {
      expect(e.message).toContain("already exists");
    }
  });

  it("password reset flow works", async () => {
    const US = userStore.UserStore || userStore.default;
    const store = new US();
    const user = await store.createUser("reset@test.com", "oldpass");
    const code = await store.setResetCode(user.id);
    expect(typeof code).toBe("string");
    expect(code.length).toBe(6);
    const valid = await store.verifyResetCode(user.id, code);
    expect(valid).toBe(true);
    const invalid = await store.verifyResetCode(user.id, "000000");
    expect(invalid).toBe(false);
  });
});
