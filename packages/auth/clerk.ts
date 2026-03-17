/**
 * @8gent/auth — Clerk Client Setup + JWT Validation via jose
 *
 * Initializes the Clerk client for server-side (Bun) usage.
 * This is a lightweight wrapper — we don't use @clerk/clerk-react
 * because the CLI has no DOM. Instead we use the REST API directly
 * for device flow and jose for JWT validation.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  type AuthConfig,
  type TokenPayload,
  DEFAULT_AUTH_CONFIG,
} from "./types.js";

// ============================================
// Config Resolution
// ============================================

/**
 * Resolve auth config from environment variables and defaults.
 * Env vars take precedence over defaults.
 */
export function resolveAuthConfig(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    ...DEFAULT_AUTH_CONFIG,
    clerkPublishableKey:
      overrides?.clerkPublishableKey ||
      process.env.CLERK_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      DEFAULT_AUTH_CONFIG.clerkPublishableKey,
    clerkSecretKey:
      overrides?.clerkSecretKey ||
      process.env.CLERK_SECRET_KEY ||
      undefined,
    clerkFrontendApi:
      overrides?.clerkFrontendApi ||
      process.env.CLERK_FRONTEND_API ||
      DEFAULT_AUTH_CONFIG.clerkFrontendApi,
    oauthClientId:
      overrides?.oauthClientId ||
      process.env.EIGHT_OAUTH_CLIENT_ID ||
      DEFAULT_AUTH_CONFIG.oauthClientId,
    deviceAuthEndpoint:
      overrides?.deviceAuthEndpoint ||
      process.env.EIGHT_DEVICE_AUTH_ENDPOINT ||
      DEFAULT_AUTH_CONFIG.deviceAuthEndpoint,
    deviceTokenEndpoint:
      overrides?.deviceTokenEndpoint ||
      process.env.EIGHT_DEVICE_TOKEN_ENDPOINT ||
      DEFAULT_AUTH_CONFIG.deviceTokenEndpoint,
    convexUrl:
      overrides?.convexUrl ||
      process.env.CONVEX_URL ||
      undefined,
    refreshBufferMs:
      overrides?.refreshBufferMs ?? DEFAULT_AUTH_CONFIG.refreshBufferMs,
    deviceFlowTimeoutMs:
      overrides?.deviceFlowTimeoutMs ?? DEFAULT_AUTH_CONFIG.deviceFlowTimeoutMs,
    ...overrides,
  };
}

// ============================================
// JWT Utilities
// ============================================

/**
 * Decode a JWT without verification (for reading claims).
 * For actual validation, use `validateToken()`.
 */
export function decodeJwt(token: string): TokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = parts[1];
    // Base64url decode
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(padded);
    return JSON.parse(decoded) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Check if a JWT is expired (with optional buffer).
 *
 * @param token - The JWT string
 * @param bufferMs - Consider expired this many ms before actual expiry. Default: 0.
 * @returns true if expired or unparseable
 */
export function isTokenExpired(token: string, bufferMs = 0): boolean {
  const payload = decodeJwt(token);
  if (!payload?.exp) return true;

  const expiresAtMs = payload.exp * 1000;
  return Date.now() >= expiresAtMs - bufferMs;
}

/**
 * Get the expiration time of a JWT in Unix milliseconds.
 * Returns 0 if the token is unparseable.
 */
export function getTokenExpiry(token: string): number {
  const payload = decodeJwt(token);
  if (!payload?.exp) return 0;
  return payload.exp * 1000;
}

// ============================================
// JWKS-based Validation via jose
// ============================================

/**
 * Cache for the JWKS remote key set.
 * jose handles key rotation and caching internally,
 * but we cache the RemoteJWKSet instance itself.
 */
let jwksInstance: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrl: string | null = null;

function getJWKS(clerkFrontendApi: string): ReturnType<typeof createRemoteJWKSet> {
  const url = `${clerkFrontendApi}/.well-known/jwks.json`;

  // Recreate if the URL changed (different config)
  if (jwksInstance && jwksUrl === url) {
    return jwksInstance;
  }

  jwksInstance = createRemoteJWKSet(new URL(url));
  jwksUrl = url;
  return jwksInstance;
}

/**
 * Validate a JWT against Clerk's JWKS endpoint using jose.
 *
 * This fetches Clerk's public keys and verifies the JWT signature,
 * algorithm, and expiration. jose handles key ID matching, caching,
 * and rotation automatically.
 *
 * @param token - The JWT to validate
 * @param config - Auth config with Clerk frontend API URL
 * @returns The decoded payload if valid, null if invalid
 */
export async function validateToken(
  token: string,
  config: AuthConfig,
): Promise<TokenPayload | null> {
  try {
    // Quick client-side expiry check before hitting the network
    if (isTokenExpired(token)) return null;

    const JWKS = getJWKS(config.clerkFrontendApi);

    const { payload } = await jwtVerify(token, JWKS, {
      // Clerk JWTs use RS256
      algorithms: ["RS256"],
    });

    // Map the verified jose payload to our TokenPayload type
    return {
      sub: payload.sub ?? "",
      email: (payload as Record<string, unknown>).email as string ?? "",
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
      iss: payload.iss ?? "",
      aud: typeof payload.aud === "string" ? payload.aud : Array.isArray(payload.aud) ? payload.aud[0] ?? "" : "",
      metadata: (payload as Record<string, unknown>).metadata as TokenPayload["metadata"],
    };
  } catch {
    return null;
  }
}

// ============================================
// Helpers
// ============================================

/**
 * Extract user profile data from a decoded JWT.
 * Used to populate AuthUser from the token without a network call.
 */
export function extractUserFromToken(payload: TokenPayload): {
  clerkId: string;
  email: string;
  githubUsername: string;
  displayName: string;
  avatar: string;
} {
  return {
    clerkId: payload.sub,
    email: payload.email || "",
    githubUsername: payload.metadata?.githubUsername || "",
    displayName:
      payload.metadata?.displayName || payload.email?.split("@")[0] || "",
    avatar: payload.metadata?.avatar || "",
  };
}
