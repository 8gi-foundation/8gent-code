/**
 * FS001 — REST API with Auth
 *
 * Tests a complete auth flow: register → login → profile → logout
 * WORK_DIR contains: database.ts, http.ts (fixtures) + auth.ts, routes.ts, app.ts (LLM-generated)
 */
import { describe, test, expect, beforeEach } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

// Import the LLM-generated app
const appMod = await import(`${workDir}/app.ts`);
const createApp: Function = appMod.default ?? appMod.createApp;
if (!createApp || typeof createApp !== "function") {
  throw new Error("app.ts must export createApp function");
}

// Import the fixture helpers for request creation
const httpMod = await import(`${workDir}/http.ts`);
const makeRequest: Function = httpMod.makeRequest;

describe("FS001: REST API with Auth", () => {
  let router: any;
  let db: any;

  beforeEach(() => {
    const app = createApp();
    router = app.router;
    db = app.db;
  });

  // ── Registration ────────────────────────────────────────────────

  test("register creates a new user", async () => {
    const req = makeRequest("POST", "/register", {
      email: "alice@test.com",
      name: "Alice",
      password: "password123",
    });
    const res = await router.handle(req);
    expect(res.status).toBe(200);
    expect(res.body.email ?? res.body.user?.email).toBe("alice@test.com");
    // Must NOT return passwordHash
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("passwordHash");
    expect(bodyStr).not.toContain("hash_");
  });

  test("register rejects missing fields", async () => {
    const req = makeRequest("POST", "/register", { email: "a@b.com" });
    const res = await router.handle(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("register rejects duplicate email", async () => {
    const body = { email: "dup@test.com", name: "A", password: "pass1234" };
    await router.handle(makeRequest("POST", "/register", body));
    const res2 = await router.handle(makeRequest("POST", "/register", body));
    expect(res2.status).toBe(409);
  });

  // ── Login ───────────────────────────────────────────────────────

  test("login returns token for valid credentials", async () => {
    await router.handle(
      makeRequest("POST", "/register", {
        email: "bob@test.com",
        name: "Bob",
        password: "secret99",
      })
    );

    const res = await router.handle(
      makeRequest("POST", "/login", {
        email: "bob@test.com",
        password: "secret99",
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(5);
  });

  test("login rejects wrong password", async () => {
    await router.handle(
      makeRequest("POST", "/register", {
        email: "carol@test.com",
        name: "Carol",
        password: "rightpass",
      })
    );

    const res = await router.handle(
      makeRequest("POST", "/login", {
        email: "carol@test.com",
        password: "wrongpass",
      })
    );

    expect(res.status).toBe(401);
  });

  test("login rejects nonexistent email", async () => {
    const res = await router.handle(
      makeRequest("POST", "/login", {
        email: "nobody@test.com",
        password: "anything",
      })
    );
    expect(res.status).toBe(401);
  });

  // ── Protected Routes ────────────────────────────────────────────

  test("profile returns user data with valid token", async () => {
    await router.handle(
      makeRequest("POST", "/register", {
        email: "dave@test.com",
        name: "Dave",
        password: "mypassword",
      })
    );

    const loginRes = await router.handle(
      makeRequest("POST", "/login", {
        email: "dave@test.com",
        password: "mypassword",
      })
    );
    const token = loginRes.body.token;

    const profileRes = await router.handle(
      makeRequest("GET", "/profile", null, {
        Authorization: `Bearer ${token}`,
        authorization: `Bearer ${token}`,
      })
    );

    expect(profileRes.status).toBe(200);
    const body = profileRes.body;
    const email = body.email ?? body.user?.email;
    expect(email).toBe("dave@test.com");
  });

  test("profile rejects request without token", async () => {
    const res = await router.handle(makeRequest("GET", "/profile"));
    expect(res.status).toBe(401);
  });

  test("profile rejects invalid token", async () => {
    const res = await router.handle(
      makeRequest("GET", "/profile", null, {
        Authorization: "Bearer invalid_token_xyz",
        authorization: "Bearer invalid_token_xyz",
      })
    );
    expect(res.status).toBe(401);
  });

  // ── Logout ──────────────────────────────────────────────────────

  test("logout invalidates the session", async () => {
    await router.handle(
      makeRequest("POST", "/register", {
        email: "eve@test.com",
        name: "Eve",
        password: "evepass123",
      })
    );

    const loginRes = await router.handle(
      makeRequest("POST", "/login", {
        email: "eve@test.com",
        password: "evepass123",
      })
    );
    const token = loginRes.body.token;

    const logoutRes = await router.handle(
      makeRequest("POST", "/logout", null, {
        Authorization: `Bearer ${token}`,
        authorization: `Bearer ${token}`,
      })
    );
    expect(logoutRes.status).toBe(200);

    // After logout, profile should fail
    const profileRes = await router.handle(
      makeRequest("GET", "/profile", null, {
        Authorization: `Bearer ${token}`,
        authorization: `Bearer ${token}`,
      })
    );
    expect(profileRes.status).toBe(401);
  });

  // ── End-to-End Flow ─────────────────────────────────────────────

  test("full flow: register → login → profile → logout → profile fails", async () => {
    // Register
    const regRes = await router.handle(
      makeRequest("POST", "/register", {
        email: "fullflow@test.com",
        name: "Full Flow",
        password: "testtest",
      })
    );
    expect(regRes.status).toBe(200);

    // Login
    const loginRes = await router.handle(
      makeRequest("POST", "/login", {
        email: "fullflow@test.com",
        password: "testtest",
      })
    );
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    // Profile
    const profileRes = await router.handle(
      makeRequest("GET", "/profile", null, {
        Authorization: `Bearer ${token}`,
        authorization: `Bearer ${token}`,
      })
    );
    expect(profileRes.status).toBe(200);

    // Logout
    const logoutRes = await router.handle(
      makeRequest("POST", "/logout", null, {
        Authorization: `Bearer ${token}`,
        authorization: `Bearer ${token}`,
      })
    );
    expect(logoutRes.status).toBe(200);

    // Profile after logout
    const failRes = await router.handle(
      makeRequest("GET", "/profile", null, {
        Authorization: `Bearer ${token}`,
        authorization: `Bearer ${token}`,
      })
    );
    expect(failRes.status).toBe(401);
  });
});
