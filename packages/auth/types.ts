/**
 * @8gent/auth — Type Definitions
 *
 * All auth-related types for the 8gent authentication system.
 * These types are shared across packages/auth, packages/db, and the TUI.
 */

// ============================================
// User Identity
// ============================================

/** Authenticated user profile, populated from Clerk + GitHub OAuth. */
export interface AuthUser {
  /** Clerk user ID (the `sub` claim in the JWT). */
  clerkId: string;
  /** Primary email address. */
  email: string;
  /** GitHub username (from OAuth). */
  githubUsername: string;
  /** Display name (GitHub profile name or email prefix). */
  displayName: string;
  /** GitHub avatar URL. */
  avatar: string;
  /** Current subscription plan. */
  plan: UserPlan;
  /** Account creation timestamp (Unix ms). */
  createdAt: number;
  /** Last activity timestamp (Unix ms). */
  lastActiveAt: number;
  /** GitHub OAuth token — only stored locally, never in JWT. */
  githubToken?: string;
}

export type UserPlan = "free" | "pro" | "team";

// ============================================
// Auth State Machine
// ============================================

/** The current authentication state of the CLI session. */
export type AuthState =
  | { state: "unknown" }
  | { state: "anonymous" }
  | { state: "authenticated"; user: AuthUser; tokenExpiresAt: number }
  | { state: "refreshing"; user: AuthUser }
  | { state: "error"; error: string; previousUser?: AuthUser };

/** Simplified boolean check result with optional user. */
export interface AuthCheck {
  authenticated: boolean;
  user: AuthUser | null;
  plan: UserPlan | null;
}

// ============================================
// JWT / Token
// ============================================

/** Decoded JWT payload from Clerk. */
export interface TokenPayload {
  /** Subject — Clerk user ID. */
  sub: string;
  /** Email address. */
  email: string;
  /** Issued at (Unix seconds). */
  iat: number;
  /** Expiration (Unix seconds). */
  exp: number;
  /** Issuer — Clerk frontend API URL. */
  iss: string;
  /** Audience. */
  aud: string;
  /** GitHub metadata from OAuth. */
  metadata?: {
    githubUsername?: string;
    displayName?: string;
    avatar?: string;
  };
}

/** Stored token bundle (JWT + optional refresh token). */
export interface StoredToken {
  /** The JWT access token. */
  accessToken: string;
  /** Optional refresh token for silent renewal. */
  refreshToken?: string;
  /** Expiration timestamp (Unix ms). */
  expiresAt: number;
  /** When the token was stored (Unix ms). */
  storedAt: number;
}

// ============================================
// Device Code Flow
// ============================================

/** State of the device code authorization flow. */
export type DeviceFlowState =
  | { phase: "idle" }
  | {
      phase: "awaiting_user";
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      deviceCode: string;
      expiresAt: number;
      interval: number;
    }
  | { phase: "polling"; deviceCode: string; attempts: number }
  | { phase: "completed"; accessToken: string; refreshToken?: string }
  | { phase: "expired" }
  | { phase: "denied" }
  | { phase: "error"; error: string };

/** Response from the device authorization endpoint. */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Response from the device token endpoint. */
export interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/** Error response from the device token endpoint. */
export interface DeviceTokenErrorResponse {
  error:
    | "authorization_pending"
    | "slow_down"
    | "expired_token"
    | "access_denied";
  error_description?: string;
}

// ============================================
// Configuration
// ============================================

/** Auth configuration — Clerk keys and endpoints. */
export interface AuthConfig {
  /** Clerk publishable key (pk_live_xxx or pk_test_xxx). */
  clerkPublishableKey: string;
  /** Clerk secret key (sk_live_xxx or sk_test_xxx). For server-side only. */
  clerkSecretKey?: string;
  /** Clerk frontend API URL (e.g., https://clerk.8gent.app). */
  clerkFrontendApi: string;
  /** OAuth client ID for device flow. */
  oauthClientId: string;
  /** Device authorization endpoint. */
  deviceAuthEndpoint: string;
  /** Device token endpoint. */
  deviceTokenEndpoint: string;
  /** Convex deployment URL. */
  convexUrl?: string;
  /** Token refresh buffer — refresh this many ms before expiry. Default: 300000 (5 min). */
  refreshBufferMs: number;
  /** Device flow poll timeout in ms. Default: 900000 (15 min). */
  deviceFlowTimeoutMs: number;
}

/** Defaults for auth config — override with env vars or .8gent/config.json. */
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  clerkPublishableKey: "",
  clerkFrontendApi: "https://clerk.8gent.app",
  oauthClientId: "",
  deviceAuthEndpoint: "https://clerk.8gent.app/v1/oauth/device/authorize",
  deviceTokenEndpoint: "https://clerk.8gent.app/v1/oauth/device/token",
  refreshBufferMs: 5 * 60 * 1000, // 5 minutes
  deviceFlowTimeoutMs: 15 * 60 * 1000, // 15 minutes
};

// ============================================
// Token Store Interface
// ============================================

/** Abstract interface for secure token persistence. */
export interface TokenStore {
  /** Store a token bundle. */
  store(token: StoredToken): Promise<void>;
  /** Retrieve the stored token, or null if none exists. */
  retrieve(): Promise<StoredToken | null>;
  /** Remove the stored token. */
  clear(): Promise<void>;
  /** Check if a token exists without retrieving it. */
  exists(): Promise<boolean>;
}

// ============================================
// Event Callbacks
// ============================================

/** Callbacks for auth lifecycle events. */
export interface AuthCallbacks {
  /** Called when device flow starts — display code to user. */
  onDeviceCode?: (userCode: string, verificationUri: string) => void;
  /** Called on each poll attempt during device flow. */
  onPollAttempt?: (attempt: number) => void;
  /** Called when login succeeds. */
  onLoginSuccess?: (user: AuthUser) => void;
  /** Called when login fails. */
  onLoginError?: (error: string) => void;
  /** Called on logout. */
  onLogout?: () => void;
  /** Called when token is refreshed transparently. */
  onTokenRefreshed?: () => void;
  /** Called when auth state changes. */
  onStateChange?: (state: AuthState) => void;
}
