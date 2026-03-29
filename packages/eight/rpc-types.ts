/**
 * 8gent Code - JSON-RPC 2.0 Types
 *
 * Types for the headless RPC mode (stdin/stdout).
 * Protocol: newline-delimited JSON-RPC 2.0.
 */

// ── Incoming (caller -> 8gent) ────────────────────────────────────

export interface RPCRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

// ── Outgoing (8gent -> caller) ────────────────────────────────────

export interface RPCResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: RPCError;
}

export interface RPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── Standard JSON-RPC error codes ─────────────────────────────────

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
