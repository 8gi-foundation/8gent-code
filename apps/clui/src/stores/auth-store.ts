/**
 * 8gent CLUI -- Auth Store (Zustand)
 *
 * Wraps the AuthManager from @8gent/auth into a reactive Zustand store.
 * Provides user state, login/logout actions, and Convex token sync.
 *
 * Design:
 * - Auth is always optional -- anonymous mode works by default
 * - AuthManager handles token persistence (Keychain), refresh, and device flow
 * - This store provides the React-facing API with reactive state
 */

import { create } from "zustand";

// ── Types (mirrored from @8gent/auth to avoid build-time dep issues) ──

export interface AuthUser {
  clerkId: string;
  email: string;
  githubUsername: string;
  displayName: string;
  avatar: string;
  plan: "free" | "pro" | "team";
  createdAt: number;
  lastActiveAt: number;
}

export type AuthStateName =
  | "unknown"
  | "anonymous"
  | "authenticated"
  | "refreshing"
  | "error"
  | "logging_in";

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
}

export interface AuthStore {
  // State
  stateName: AuthStateName;
  user: AuthUser | null;
  error: string | null;
  isLoading: boolean;
  deviceCode: DeviceCodeInfo | null;
  pollAttempt: number;

  // Computed
  isAuthenticated: boolean;

  // Actions
  initialize: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  skipAuth: () => void;

  // Internal
  _setUser: (user: AuthUser | null) => void;
  _setStateName: (name: AuthStateName) => void;
  _setError: (error: string | null) => void;
}

// ── Lazy AuthManager loader ───────────────────────────────────────────

let _authManagerPromise: Promise<any> | null = null;

async function getAuthManager(): Promise<any> {
  if (!_authManagerPromise) {
    _authManagerPromise = import("@8gent/auth").then((mod) =>
      mod.getAuthManager(),
    ).catch(() => null);
  }
  return _authManagerPromise;
}

// ── Store ─────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthStore>((set, get) => ({
  stateName: "unknown",
  user: null,
  error: null,
  isLoading: false,
  deviceCode: null,
  pollAttempt: 0,
  isAuthenticated: false,

  initialize: async () => {
    const current = get();
    if (current.stateName !== "unknown") return;

    set({ isLoading: true });

    try {
      const manager = await getAuthManager();
      if (!manager) {
        set({
          stateName: "anonymous",
          isLoading: false,
          isAuthenticated: false,
        });
        return;
      }

      const state = await manager.initialize();

      if (state.state === "authenticated") {
        set({
          stateName: "authenticated",
          user: state.user,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      } else {
        set({
          stateName: "anonymous",
          user: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      }
    } catch (err) {
      set({
        stateName: "anonymous",
        isLoading: false,
        isAuthenticated: false,
        error: err instanceof Error ? err.message : "Auth init failed",
      });
    }
  },

  login: async () => {
    set({
      stateName: "logging_in",
      isLoading: true,
      deviceCode: null,
      pollAttempt: 0,
      error: null,
    });

    try {
      const manager = await getAuthManager();
      if (!manager) {
        set({
          stateName: "error",
          isLoading: false,
          error: "Auth system unavailable",
        });
        return;
      }

      const result = await manager.login({
        onDeviceCode: (userCode: string, verificationUri: string) => {
          set({
            deviceCode: { userCode, verificationUri },
          });
        },
        onPollAttempt: (attempt: number) => {
          set({ pollAttempt: attempt });
        },
        onLoginSuccess: (user: AuthUser) => {
          set({
            stateName: "authenticated",
            user,
            isAuthenticated: true,
            isLoading: false,
            deviceCode: null,
            error: null,
          });
        },
        onLoginError: (error: string) => {
          set({
            stateName: "error",
            isLoading: false,
            error,
            deviceCode: null,
          });
        },
      });

      // Fallback in case callbacks didn't fire
      if (result.state === "authenticated") {
        set({
          stateName: "authenticated",
          user: result.user,
          isAuthenticated: true,
          isLoading: false,
          deviceCode: null,
          error: null,
        });
      }
    } catch (err) {
      set({
        stateName: "error",
        isLoading: false,
        isAuthenticated: false,
        error: err instanceof Error ? err.message : "Login failed",
        deviceCode: null,
      });
    }
  },

  logout: async () => {
    set({ isLoading: true });

    try {
      const manager = await getAuthManager();
      if (manager) {
        await manager.logout();
      }
    } catch {
      // Logout should always succeed locally
    }

    set({
      stateName: "anonymous",
      user: null,
      isAuthenticated: false,
      isLoading: false,
      deviceCode: null,
      error: null,
    });
  },

  skipAuth: () => {
    set({
      stateName: "anonymous",
      user: null,
      isAuthenticated: false,
      isLoading: false,
      deviceCode: null,
      error: null,
    });
  },

  _setUser: (user) => set({ user }),
  _setStateName: (name) => set({ stateName: name }),
  _setError: (error) => set({ error }),
}));
