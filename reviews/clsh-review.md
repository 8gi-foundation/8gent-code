# Code Review: clsh (my-claude-utils/clsh)

**Reviewer:** Claude (automated review)
**Date:** 2025-03-15
**Repo:** https://github.com/my-claude-utils/clsh
**Version:** 0.0.1 (monorepo root) / 0.0.2 (packages)

---

## Summary

**clsh** is a browser-based remote terminal tool that exposes local PTY sessions over WebSocket, accessible from a phone or any browser. It's a monorepo (Turborepo + npm workspaces) with three packages: `@clsh/agent` (Node.js backend), `@clsh/web` (React + xterm.js frontend), and `@clsh/cli` (npx entry point).

**Overall impression:** Well-architected for an early-stage project. Clean separation of concerns, sensible security defaults, and thoughtful UX touches (QR auth, session persistence, sleep prevention). There are a few security areas worth hardening before wider adoption.

---

## Architecture

### Strengths

- **Clean monorepo structure** — `packages/{agent,web,cli}` with Turborepo orchestration. Each package has its own `tsconfig.json`, `package.json`, and build scripts. No circular dependencies.
- **Layered agent design** — The agent entry point (`index.ts`) reads like a boot sequence: config → DB → auth → server → PTY → tunnel → monitor. Easy to follow.
- **tmux integration is smart** — Using tmux control mode (`-CC`) for session persistence across server restarts is a great architectural choice. The fallback to raw PTY when tmux isn't installed is clean.
- **3-tier tunnel fallback** — ngrok → localhost.run SSH → local Wi-Fi is pragmatic. Zero-config for the common case, configurable for power users.
- **Prepared statements** — All DB queries are prepared upfront in `initDatabase()`, not constructed on-demand. Good for both performance and SQL injection prevention.

### Suggestions

- **No test suite** — `"test": "echo TODO"` in the agent package. The auth, PTY manager, and tunnel recovery logic are all testable in isolation. Unit tests for `auth.ts` (token generation/verification, JWT round-trip) and `config.ts` (env precedence) would be high-value, low-effort wins.
- **Missing health/readiness separation** — There's a `/api/health` endpoint but no distinction between liveness and readiness. If the tunnel is down but the server is up, health should reflect that.

---

## Security

### What's done well

1. **Bootstrap tokens are hashed** — Only SHA-256 hashes are stored in SQLite; raw tokens never touch the DB. 5-minute TTL limits exposure window.
2. **JWT secret persistence** — `getOrCreateJwtSecret()` generates a 256-bit secret stored at `~/.clsh/jwt_secret` with `mode: 0o600`. Survives restarts so phone JWTs stay valid.
3. **Environment stripping** — `PTYManager` strips `NGROK_AUTHTOKEN`, `RESEND_API_KEY`, `JWT_SECRET`, and `CLAUDECODE` from child process environments. Prevents credential leakage into spawned shells.
4. **WebSocket auth** — JWT verified on every WS connection upgrade. Unauthorized connections get close code `4001`.

### Issues to address

1. **JWT expiry is 30 days** (`setExpirationTime('30d')` in `createSessionJWT`)
   - The code comment says "8-hour expiry" but the actual value is `30d`. This is a significant discrepancy. For a tool that grants full shell access, 30 days is generous. Consider:
     - Aligning the comment with the code (or vice versa)
     - Implementing refresh tokens with shorter-lived access tokens
     - Adding a revocation mechanism (check JTI against a blocklist in DB)

2. **No rate limiting on bootstrap auth**
   - `POST /api/auth/bootstrap` has no rate limiting. An attacker with network access could brute-force bootstrap tokens during the 5-minute window. The 256-bit token space makes this impractical in theory, but defense-in-depth suggests adding rate limiting (e.g., 5 attempts per IP per minute).

3. **CORS is wide open**
   - The server enables `Access-Control-Allow-Origin: *` with all methods and headers. This is fine for dev but should be locked down in production tunnel mode. When accessed via ngrok, any website could make credentialed requests if cookies are involved.

4. **No CSP headers**
   - The SPA is served without Content-Security-Policy headers. Since this tool runs terminals, XSS in the web frontend would be especially dangerous (terminal injection → command execution).

5. **Token in query string** (WebSocket auth)
   - JWT is passed as a query parameter for WebSocket connections. Query strings appear in server logs, browser history, and referrer headers. Consider using the first WebSocket message for auth instead, or a short-lived ticket exchange pattern.

---

## Code Quality

### Strengths

- **TypeScript throughout** — Strict types, interfaces for all data shapes (`AgentConfig`, `PtySessionRow`, `SessionJWTClaims`, `DbStatements`). Good use of discriminated unions for message types.
- **Clean module boundaries** — Each file in `packages/agent/src/` has a single responsibility. No god modules.
- **Error handling is pragmatic** — `try/catch` with fallbacks where appropriate (config loading, caffeinate, tunnel creation). Errors don't crash the process unnecessarily.
- **Modern Node.js** — ES modules, `node:` protocol imports, `import.meta.dirname`. Requires Node 20+ which is reasonable.

### Nits

- **`parseDotEnvContent` is hand-rolled** — Works fine but doesn't handle multiline values, escape sequences, or `export` prefix. Consider `dotenv` if edge cases matter, though for this use case the simple parser is probably fine.
- **Magic numbers** — `BOOTSTRAP_TOKEN_TTL_MS` is well-named, but other constants (max 10,000 buffer entries, 2.5s idle timeout, 30s heartbeat interval) are inline. Extract to named constants for clarity.
- **`String()` wrapping in template literals** — e.g., `` `Recovered ${String(recovered.length)} session(s)` ``. This is unnecessary — template literals already call `.toString()`. Minor style thing.

---

## Frontend (Web)

- **React 18 + xterm.js** — Solid combo for a terminal web app. WebGL renderer for xterm is the right call for performance.
- **Tailwind v4** — Modern CSS framework choice. The skin system (6 customizable keyboard themes) is a fun touch.
- **Component structure** — `App.tsx` is a clean state machine: auth gate → grid view → terminal view → skin studio. Good use of `useCallback` and `useRef` for the "navigate to new session" pattern.
- **Hook decomposition** — `useAuth`, `useSessionManager`, `useSkin` keep App.tsx focused on routing/state, not implementation details.

---

## Operational Concerns

1. **Session limit** — Up to 8 concurrent PTY sessions. Good that there's a cap, but it's not clear if it's enforced server-side or just a UI constraint. Enforce server-side to prevent abuse.
2. **No logging framework** — Uses `console.log` throughout. For a tool that manages remote shell access, structured logging (with timestamps, levels, and session IDs) would help debugging and auditing.
3. **Sleep/wake detection** — The tunnel monitor uses "time drift" to detect system sleep, which is clever but fragile. A 15-second gap in monotonic time triggers tunnel recreation. Document this heuristic clearly.
4. **Database in home directory** — `~/.clsh/clsh.db` with WAL mode. Fine for single-user, but if two agent instances run simultaneously they'll share the DB. Consider a lock file or PID check.

---

## Verdict

**clsh is a well-built tool** with a clear purpose and clean implementation. The architecture is sound — monorepo with proper separation, typed throughout, sensible defaults. The security model is reasonable for a personal/dev tool (QR-based bootstrap → JWT → authenticated WebSocket), but needs tightening before any multi-user or public deployment.

### Priority fixes
1. Fix the JWT expiry comment/code mismatch (30d vs "8 hours")
2. **WebSocket listener leak** — Every `session_subscribe`/`session_create` pushes `onData`/`onUpdate`/`onExit` callbacks onto PTY sessions, but `ws.on('close')` only clears the subscription set, not those listeners. Repeated client reconnects to the same session cause unbounded listener array growth. Add an unregister mechanism on WebSocket close.
3. Add rate limiting to the bootstrap endpoint
4. Lock down CORS for production/tunnel mode
5. Add CSP headers to the SPA
6. Move WebSocket auth out of query strings

### Nice-to-haves
- Unit tests for auth and config modules
- Structured logging
- Server-side session limit enforcement
- Liveness vs readiness health checks
