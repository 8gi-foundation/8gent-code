/**
 * @8gent/auth — Public API
 *
 * Authentication for 8gent Code.
 * Clerk + GitHub OAuth, device code flow, secure token storage.
 *
 * Usage:
 *   import { getAuthManager, login, logout, getUser, isAuthenticated } from "@8gent/auth";
 *
 * The auth system is designed to be non-blocking:
 * - Anonymous mode is always available
 * - Auth state is cached locally
 * - Network failures degrade gracefully (never crash)
 */

import type {
  AuthUser,
  AuthState,
  AuthConfig,
  AuthCallbacks,
  StoredToken,
  TokenStore,
  UserPlan,
} from "./types.js";
import { resolveAuthConfig, decodeJwt, isTokenExpired, getTokenExpiry, validateToken, extractUserFromToken } from "./clerk.js";
import { executeDeviceFlow, refreshAccessToken } from "./device-flow.js";
import { getTokenStore } from "./token-store.js";

// Re-export types
export type {
  AuthUser,
  AuthState,
  AuthConfig,
  AuthCallbacks,
  StoredToken,
  TokenStore,
  UserPlan,
} from "./types.js";

// Re-export submodules
export { resolveAuthConfig, decodeJwt, isTokenExpired, validateToken } from "./clerk.js";
export { executeDeviceFlow, formatDeviceFlowStatus } from "./device-flow.js";
export { getTokenStore, KeychainTokenStore, EncryptedFileTokenStore } from "./token-store.js";
export { requireAuth, requirePlan, checkAuth, hasPlan, authenticateRequest } from "./middleware.js";
export { runCLIAuthFlow, type CLIAuthResult, type CLIAuthCallbacks } from "./cli-auth-server.js";

// ============================================
// AuthManager — Central Auth State Machine
// ============================================

export class AuthManager {
  private state: AuthState = { state: "unknown" };
  private config: AuthConfig;
  private tokenStore: TokenStore;
  private callbacks: AuthCallbacks;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor(config?: Partial<AuthConfig>, callbacks?: AuthCallbacks) {
    this.config = resolveAuthConfig(config);
    this.tokenStore = getTokenStore();
    this.callbacks = callbacks ?? {};
  }

  // ---------- Initialization ----------

  /**
   * Initialize auth state by checking for a stored token.
   * Call this once at app startup. Non-blocking — returns immediately
   * if no token exists (anonymous mode).
   */
  async initialize(): Promise<AuthState> {
    if (this.initialized) return this.state;

    try {
      const storedToken = await this.tokenStore.retrieve();

      if (!storedToken) {
        this.setState({ state: "anonymous" });
        this.initialized = true;
        return this.state;
      }

      // Check if token is expired
      if (isTokenExpired(storedToken.accessToken, this.config.refreshBufferMs)) {
        // Try to refresh
        if (storedToken.refreshToken) {
          const refreshed = await this.tryRefresh(storedToken.refreshToken);
          if (refreshed) {
            this.initialized = true;
            return this.state;
          }
        }

        // Refresh failed or no refresh token — go anonymous
        await this.tokenStore.clear();
        this.setState({ state: "anonymous" });
        this.initialized = true;
        return this.state;
      }

      // Token is valid — extract user
      const payload = decodeJwt(storedToken.accessToken);
      if (!payload) {
        await this.tokenStore.clear();
        this.setState({ state: "anonymous" });
        this.initialized = true;
        return this.state;
      }

      const profile = extractUserFromToken(payload);
      const user: AuthUser = {
        ...profile,
        plan: "free", // Default — actual plan comes from Convex
        createdAt: 0,
        lastActiveAt: Date.now(),
      };

      this.setState({
        state: "authenticated",
        user,
        tokenExpiresAt: storedToken.expiresAt,
      });

      // Schedule token refresh
      this.scheduleRefresh(storedToken);

      this.initialized = true;
      return this.state;
    } catch {
      // Any error during init — default to anonymous
      this.setState({ state: "anonymous" });
      this.initialized = true;
      return this.state;
    }
  }

  // ---------- Login ----------

  /**
   * Start the login flow (device code authorization).
   *
   * @param callbacks - Optional callbacks for UI updates (overrides constructor callbacks)
   * @returns The final auth state after login completes
   */
  async login(callbacks?: AuthCallbacks): Promise<AuthState> {
    const cb = { ...this.callbacks, ...callbacks };

    // If already authenticated, return current state
    if (this.state.state === "authenticated") {
      cb.onLoginSuccess?.(this.state.user);
      return this.state;
    }

    // Execute device flow
    const result = await executeDeviceFlow(this.config, cb);

    if (result.phase !== "completed") {
      const error =
        result.phase === "expired"
          ? "Device code expired. Please try again."
          : result.phase === "denied"
            ? "Login was denied."
            : result.phase === "error"
              ? result.error
              : "Login failed.";

      this.setState({ state: "error", error });
      cb.onLoginError?.(error);
      return this.state;
    }

    // Store the token
    const expiresAt = getTokenExpiry(result.accessToken);
    const storedToken: StoredToken = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt,
      storedAt: Date.now(),
    };

    await this.tokenStore.store(storedToken);

    // Extract user from JWT
    const payload = decodeJwt(result.accessToken);
    if (!payload) {
      const error = "Failed to decode auth token.";
      this.setState({ state: "error", error });
      cb.onLoginError?.(error);
      return this.state;
    }

    const profile = extractUserFromToken(payload);
    const user: AuthUser = {
      ...profile,
      plan: "free", // Will be updated from Convex
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.setState({
      state: "authenticated",
      user,
      tokenExpiresAt: expiresAt,
    });

    // Schedule refresh
    this.scheduleRefresh(storedToken);

    cb.onLoginSuccess?.(user);
    return this.state;
  }

  // ---------- Logout ----------

  /**
   * Log out — clear stored token and reset to anonymous.
   * Works offline (no network call needed).
   */
  async logout(): Promise<void> {
    // Cancel refresh timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Clear stored token
    await this.tokenStore.clear();

    // Reset state
    this.setState({ state: "anonymous" });
    this.callbacks.onLogout?.();
  }

  // ---------- State Accessors ----------

  /** Get the current auth state. */
  getState(): AuthState {
    return this.state;
  }

  /** Get the current user, or null if not authenticated. */
  getUser(): AuthUser | null {
    if (this.state.state === "authenticated") return this.state.user;
    if (this.state.state === "refreshing") return this.state.user;
    return null;
  }

  /** Check if the user is authenticated. */
  isAuthenticated(): boolean {
    return (
      this.state.state === "authenticated" ||
      this.state.state === "refreshing"
    );
  }

  /** Get the stored access token (for Convex auth). */
  async getAccessToken(): Promise<string | null> {
    const stored = await this.tokenStore.retrieve();
    if (!stored) return null;
    if (isTokenExpired(stored.accessToken)) return null;
    return stored.accessToken;
  }

  // ---------- Token Refresh ----------

  /**
   * Attempt to refresh the access token using the refresh token.
   * Updates state and stored token on success.
   */
  private async tryRefresh(refreshToken: string): Promise<boolean> {
    const currentUser = this.getUser();
    if (currentUser) {
      this.setState({ state: "refreshing", user: currentUser });
    }

    try {
      const result = await refreshAccessToken(refreshToken, this.config);
      if (!result) {
        if (currentUser) {
          this.setState({
            state: "error",
            error: "Token refresh failed",
            previousUser: currentUser,
          });
        }
        return false;
      }

      // Store new token
      const expiresAt = getTokenExpiry(result.access_token);
      const storedToken: StoredToken = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token || refreshToken,
        expiresAt,
        storedAt: Date.now(),
      };

      await this.tokenStore.store(storedToken);

      // Update state
      const payload = decodeJwt(result.access_token);
      if (!payload) return false;

      const profile = extractUserFromToken(payload);
      const user: AuthUser = {
        ...profile,
        plan: currentUser?.plan ?? "free",
        createdAt: currentUser?.createdAt ?? 0,
        lastActiveAt: Date.now(),
      };

      this.setState({
        state: "authenticated",
        user,
        tokenExpiresAt: expiresAt,
      });

      this.scheduleRefresh(storedToken);
      this.callbacks.onTokenRefreshed?.();
      return true;
    } catch {
      if (currentUser) {
        this.setState({
          state: "error",
          error: "Token refresh failed",
          previousUser: currentUser,
        });
      }
      return false;
    }
  }

  /**
   * Schedule automatic token refresh before expiration.
   */
  private scheduleRefresh(token: StoredToken): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    if (!token.refreshToken) return;

    const timeUntilRefresh = token.expiresAt - Date.now() - this.config.refreshBufferMs;
    if (timeUntilRefresh <= 0) {
      // Already past refresh window — refresh now
      this.tryRefresh(token.refreshToken);
      return;
    }

    this.refreshTimer = setTimeout(() => {
      if (token.refreshToken) {
        this.tryRefresh(token.refreshToken);
      }
    }, timeUntilRefresh);
  }

  // ---------- State Management ----------

  private setState(newState: AuthState): void {
    this.state = newState;
    this.callbacks.onStateChange?.(newState);
  }

  /** Clean up timers. Call when the app exits. */
  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

// ============================================
// Singleton
// ============================================

let _authManager: AuthManager | null = null;

/** Get (or create) the global AuthManager singleton. */
export function getAuthManager(
  config?: Partial<AuthConfig>,
  callbacks?: AuthCallbacks,
): AuthManager {
  if (!_authManager) {
    _authManager = new AuthManager(config, callbacks);
  }
  return _authManager;
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Initialize auth and return the current state.
 * Call once at app startup. Safe to call multiple times (idempotent).
 */
export async function initAuth(
  config?: Partial<AuthConfig>,
  callbacks?: AuthCallbacks,
): Promise<AuthState> {
  const manager = getAuthManager(config, callbacks);
  return manager.initialize();
}

/**
 * Start the login flow. Opens browser for GitHub OAuth.
 */
export async function login(callbacks?: AuthCallbacks): Promise<AuthState> {
  const manager = getAuthManager();
  await manager.initialize();
  return manager.login(callbacks);
}

/**
 * Log out and clear stored credentials.
 */
export async function logout(): Promise<void> {
  const manager = getAuthManager();
  return manager.logout();
}

/**
 * Get the current authenticated user, or null.
 */
export function getUser(): AuthUser | null {
  const manager = getAuthManager();
  return manager.getUser();
}

/**
 * Check if the user is currently authenticated.
 */
export function isAuthenticated(): boolean {
  const manager = getAuthManager();
  return manager.isAuthenticated();
}
