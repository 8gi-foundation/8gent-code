/**
 * jwt-decoder - Decode and inspect JWT tokens without signature verification.
 * Useful for debugging agent auth flows, inspecting claims, and checking expiry.
 * No external dependencies.
 */

export interface JWTHeader {
  alg: string;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

export interface JWTPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [key: string]: unknown;
}

export interface DecodedJWT {
  header: JWTHeader;
  payload: JWTPayload;
  signature: string;
  raw: { header: string; payload: string; signature: string };
}

export interface JWTInspection {
  decoded: DecodedJWT;
  algorithm: string;
  isExpired: boolean;
  expiresAt: Date | null;
  issuedAt: Date | null;
  notBefore: Date | null;
  subject: string | null;
  issuer: string | null;
  audience: string | string[] | null;
  claims: Record<string, unknown>;
  formatted: string;
}

function base64UrlDecode(str: string): string {
  // Pad to multiple of 4
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  // Replace URL-safe chars
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Decode a JWT token into its constituent parts without verifying the signature.
 * Throws if the token is malformed.
 */
export function decodeJWT(token: string): DecodedJWT {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    throw new Error(`Malformed JWT: expected 3 parts, got ${parts.length}`);
  }
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: JWTHeader;
  let payload: JWTPayload;

  try {
    header = JSON.parse(base64UrlDecode(rawHeader)) as JWTHeader;
  } catch {
    throw new Error("Failed to decode JWT header - invalid base64url or JSON");
  }

  try {
    payload = JSON.parse(base64UrlDecode(rawPayload)) as JWTPayload;
  } catch {
    throw new Error("Failed to decode JWT payload - invalid base64url or JSON");
  }

  return {
    header,
    payload,
    signature: rawSignature,
    raw: { header: rawHeader, payload: rawPayload, signature: rawSignature },
  };
}

/**
 * Check whether a JWT token is expired based on the `exp` claim.
 * Returns false if there is no `exp` claim (treat as non-expiring).
 */
export function isExpired(token: string): boolean {
  const { payload } = decodeJWT(token);
  if (payload.exp === undefined) return false;
  return Date.now() / 1000 > payload.exp;
}

/**
 * Extract all claims from the JWT payload.
 */
export function getClaims(token: string): Record<string, unknown> {
  const { payload } = decodeJWT(token);
  return { ...payload };
}

/**
 * Full inspection: decode, check expiry, extract all metadata, produce
 * a human-readable summary string.
 */
export function inspectJWT(token: string): JWTInspection {
  const decoded = decodeJWT(token);
  const { header, payload } = decoded;

  const expiresAt = payload.exp ? new Date(payload.exp * 1000) : null;
  const issuedAt = payload.iat ? new Date(payload.iat * 1000) : null;
  const notBefore = payload.nbf ? new Date(payload.nbf * 1000) : null;
  const expired = payload.exp !== undefined ? Date.now() / 1000 > payload.exp : false;

  const lines: (string | null)[] = [
    `Algorithm : ${header.alg}`,
    `Type      : ${header.typ ?? "(not set)"}`,
    header.kid ? `Key ID    : ${header.kid}` : null,
    ``,
    `Subject   : ${payload.sub ?? "(not set)"}`,
    `Issuer    : ${payload.iss ?? "(not set)"}`,
    `Audience  : ${Array.isArray(payload.aud) ? payload.aud.join(", ") : (payload.aud ?? "(not set)")}`,
    ``,
    `Issued At : ${issuedAt ? issuedAt.toISOString() : "(not set)"}`,
    `Not Before: ${notBefore ? notBefore.toISOString() : "(not set)"}`,
    `Expires At: ${expiresAt ? expiresAt.toISOString() : "(no expiry)"}`,
    `Expired   : ${payload.exp === undefined ? "n/a" : expired ? "YES" : "no"}`,
  ];

  const extraClaims = Object.entries(payload).filter(
    ([k]) => !["iss", "sub", "aud", "exp", "nbf", "iat", "jti"].includes(k)
  );
  if (extraClaims.length > 0) {
    lines.push(``, `Custom Claims:`);
    for (const [k, v] of extraClaims) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }

  return {
    decoded,
    algorithm: header.alg,
    isExpired: expired,
    expiresAt,
    issuedAt,
    notBefore,
    subject: payload.sub ?? null,
    issuer: payload.iss ?? null,
    audience: payload.aud ?? null,
    claims: getClaims(token),
    formatted: (lines.filter((l) => l !== null) as string[]).join("\n"),
  };
}
