/**
 * API Versioning - Version negotiation for the Daemon Protocol.
 *
 * Handles version negotiation on WebSocket connect, provides a backwards
 * compatibility shim for older clients, and emits deprecation warnings
 * when clients use outdated protocol versions.
 */

/** Supported protocol versions, newest first. */
export const SUPPORTED_VERSIONS = ["1.2", "1.1", "1.0"] as const;
export type ProtocolVersion = (typeof SUPPORTED_VERSIONS)[number];

/** The current (latest) protocol version. */
export const CURRENT_VERSION: ProtocolVersion = SUPPORTED_VERSIONS[0];

/** Versions that still work but will be removed in a future release. */
const DEPRECATED_VERSIONS = new Set<ProtocolVersion>(["1.0"]);

/** Per-version removal timeline. Informational only - not enforced. */
const DEPRECATION_NOTICES: Partial<Record<ProtocolVersion, string>> = {
  "1.0": "v1.0 is deprecated and will be removed in daemon 0.3.0. Upgrade to v1.2.",
};

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

export interface NegotiationResult {
  version: ProtocolVersion;
  deprecated: boolean;
  warning: string | null;
}

/**
 * Negotiate the best protocol version both sides support.
 *
 * The client sends a sorted list of versions it can speak (newest first).
 * We pick the highest version present in both lists. If no overlap exists
 * we return `null` so the caller can reject the connection.
 */
export function negotiate(
  clientVersions: string | string[] | undefined,
): NegotiationResult | null {
  // No header / empty - assume current version (new client)
  if (!clientVersions || (Array.isArray(clientVersions) && clientVersions.length === 0)) {
    return { version: CURRENT_VERSION, deprecated: false, warning: null };
  }

  const offered = Array.isArray(clientVersions) ? clientVersions : [clientVersions];
  const supported = new Set<string>(SUPPORTED_VERSIONS);

  for (const v of offered) {
    if (supported.has(v)) {
      const version = v as ProtocolVersion;
      const deprecated = DEPRECATED_VERSIONS.has(version);
      const warning = DEPRECATION_NOTICES[version] ?? null;
      return { version, deprecated, warning };
    }
  }

  // No common version found
  return null;
}

// ---------------------------------------------------------------------------
// Backwards compatibility shims
// ---------------------------------------------------------------------------

/**
 * Transform an outbound message so older clients can understand it.
 *
 * v1.0 clients expect `session:created` payloads without the `channel` field
 * and use `result` instead of `output` on tool results.
 *
 * v1.1 clients are fully compatible with v1.2 shapes today.
 */
export function shimOutbound(version: ProtocolVersion, msg: Record<string, unknown>): Record<string, unknown> {
  if (version === CURRENT_VERSION) return msg;

  if (version === "1.0") {
    // v1.0 used "result" instead of "output" on tool events
    if (msg.type === "event" && (msg as any).event === "tool:result") {
      const payload = { ...(msg.payload as Record<string, unknown>) };
      if ("output" in payload) {
        payload.result = payload.output;
        delete payload.output;
      }
      return { ...msg, payload };
    }
    // Strip fields v1.0 doesn't know about
    if (msg.type === "session:created") {
      const { channel: _ch, ...rest } = msg;
      return rest;
    }
  }

  return msg;
}

/**
 * Transform an inbound message from an older client into the current shape.
 *
 * v1.0 clients send `session:new` instead of `session:create`.
 */
export function shimInbound(version: ProtocolVersion, msg: Record<string, unknown>): Record<string, unknown> {
  if (version === CURRENT_VERSION) return msg;

  if (version === "1.0") {
    if (msg.type === "session:new") {
      return { ...msg, type: "session:create" };
    }
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a raw version string is currently supported. */
export function isSupported(version: string): version is ProtocolVersion {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

/** Return a human-readable rejection message for failed negotiation. */
export function rejectionMessage(clientVersions: string[]): string {
  return (
    `No compatible protocol version. Client offered [${clientVersions.join(", ")}], ` +
    `server supports [${SUPPORTED_VERSIONS.join(", ")}].`
  );
}
