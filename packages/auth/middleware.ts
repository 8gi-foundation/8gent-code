/**
 * @8gent/auth — Auth Middleware
 *
 * Middleware for protecting HTTP endpoints (if 8gent exposes any local HTTP APIs).
 * Also provides the `requireAuth()` guard for gating features by plan.
 */

import type { AuthUser, UserPlan, AuthState } from "./types.js";
import { getAuthManager } from "./index.js";

// ============================================
// Feature Gating
// ============================================

/**
 * Require authentication. Throws if the user is not logged in.
 *
 * @param feature - Optional feature name for the error message
 * @returns The authenticated user
 * @throws Error if not authenticated
 */
export async function requireAuth(feature?: string): Promise<AuthUser> {
  const manager = getAuthManager();
  const state = manager.getState();

  if (state.state !== "authenticated") {
    const featureMsg = feature ? ` to use ${feature}` : "";
    throw new Error(
      `Authentication required${featureMsg}. Run \`8gent auth login\` to sign in.`,
    );
  }

  return state.user;
}

/**
 * Require a specific plan tier (or higher).
 * Plan hierarchy: free < pro < team.
 *
 * @param requiredPlan - Minimum plan required
 * @param feature - Optional feature name for the error message
 * @returns The authenticated user
 * @throws Error if not authenticated or plan is insufficient
 */
export async function requirePlan(
  requiredPlan: UserPlan,
  feature?: string,
): Promise<AuthUser> {
  const user = await requireAuth(feature);

  const planHierarchy: Record<UserPlan, number> = {
    free: 0,
    pro: 1,
    team: 2,
  };

  if (planHierarchy[user.plan] < planHierarchy[requiredPlan]) {
    const featureMsg = feature ? ` ${feature}` : " this feature";
    throw new Error(
      `${requiredPlan} plan or higher required for${featureMsg}. ` +
        `You are on the ${user.plan} plan. Upgrade at https://8gent.app/pricing`,
    );
  }

  return user;
}

// ============================================
// HTTP Middleware (for local API server)
// ============================================

/**
 * Extract and validate auth token from an HTTP request.
 * Looks for: Authorization: Bearer <token>
 *
 * @param request - The incoming Request object
 * @returns The authenticated user, or null if no valid token
 */
export async function authenticateRequest(
  request: Request,
): Promise<AuthUser | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  if (!token) return null;

  // Validate the token using the auth manager's clerk instance
  const { validateToken } = await import("./clerk.js");
  const { resolveAuthConfig } = await import("./clerk.js");
  const config = resolveAuthConfig();

  const payload = await validateToken(token, config);
  if (!payload) return null;

  const { extractUserFromToken } = await import("./clerk.js");
  const profile = extractUserFromToken(payload);

  return {
    ...profile,
    plan: "free", // Would need DB lookup for actual plan
    createdAt: 0,
    lastActiveAt: Date.now(),
  };
}

// ============================================
// Auth Check Helpers
// ============================================

/**
 * Check if the current user is authenticated (non-throwing).
 * Returns a simple { authenticated, user, plan } object.
 */
export function checkAuth(): {
  authenticated: boolean;
  user: AuthUser | null;
  plan: UserPlan | null;
} {
  try {
    const manager = getAuthManager();
    const state = manager.getState();

    if (state.state === "authenticated") {
      return {
        authenticated: true,
        user: state.user,
        plan: state.user.plan,
      };
    }

    return { authenticated: false, user: null, plan: null };
  } catch {
    return { authenticated: false, user: null, plan: null };
  }
}

/**
 * Check if the current user has at least the given plan.
 * Returns false if not authenticated.
 */
export function hasPlan(requiredPlan: UserPlan): boolean {
  const { authenticated, plan } = checkAuth();
  if (!authenticated || !plan) return false;

  const planHierarchy: Record<UserPlan, number> = {
    free: 0,
    pro: 1,
    team: 2,
  };

  return planHierarchy[plan] >= planHierarchy[requiredPlan];
}
