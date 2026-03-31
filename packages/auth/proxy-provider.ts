/**
 * @8gent/auth - Control Plane Proxy Provider
 *
 * Routes LLM requests through the 8GI control plane gateway instead of
 * calling providers directly. The proxy is OpenAI-compatible, so it
 * slots into the existing AI SDK provider system.
 *
 * Local-first: if the proxy is unreachable, always fall back to Ollama.
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ProviderConfig } from "../ai/providers";

// ============================================
// Types
// ============================================

export interface ProxyConfig {
  /** Control plane proxy URL. */
  proxyUrl: string;
  /** Bearer token from 8gent.app login. */
  token: string | null;
  /** Unique vessel identifier for this install. */
  vesselId: string;
}

const DEFAULT_PROXY_URL = "https://8gi-model-proxy.fly.dev";
const AUTH_CONFIG_PATH = path.join(os.homedir(), ".8gent", "auth-proxy.json");

// ============================================
// ProxyConfig persistence
// ============================================

interface StoredProxyConfig {
  proxyUrl: string;
  vesselId: string;
}

function ensureDataDir(): void {
  const dir = path.join(os.homedir(), ".8gent");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateVesselId(): string {
  return `vessel_${crypto.randomBytes(12).toString("hex")}`;
}

function loadProxyConfig(): StoredProxyConfig {
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf-8"));
      return {
        proxyUrl: data.proxyUrl || DEFAULT_PROXY_URL,
        vesselId: data.vesselId || generateVesselId(),
      };
    }
  } catch {
    // Corrupted file - regenerate
  }
  // First run - generate vessel ID and persist
  const config: StoredProxyConfig = {
    proxyUrl: DEFAULT_PROXY_URL,
    vesselId: generateVesselId(),
  };
  saveProxyConfig(config);
  return config;
}

function saveProxyConfig(config: StoredProxyConfig): void {
  ensureDataDir();
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ============================================
// Proxy Availability
// ============================================

/**
 * Check if the control plane proxy is reachable.
 * Uses a 3-second timeout to avoid blocking the user.
 */
export async function isProxyAvailable(proxyUrl?: string): Promise<boolean> {
  const url = proxyUrl || DEFAULT_PROXY_URL;
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================
// Proxy Headers
// ============================================

/**
 * Build headers for proxied requests.
 * Returns Authorization + X-Vessel-Id headers.
 */
export function getProxyHeaders(token: string, vesselId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Vessel-Id": vesselId,
    "X-Client": "8gent-code",
  };
}

// ============================================
// Provider Config Builder
// ============================================

/**
 * Build a ProviderConfig that routes through the control plane proxy.
 *
 * The proxy speaks OpenAI-compatible API, so it works with the existing
 * AI SDK createOpenAICompatible provider. The proxy handles model routing,
 * rate limiting, and usage tracking on the server side.
 *
 * @param token - Bearer token from auth
 * @param model - Model to request (proxy resolves to best available)
 * @param proxyUrl - Override proxy URL (default: https://8gi-model-proxy.fly.dev)
 */
export function buildProxyProviderConfig(
  token: string,
  model?: string,
  proxyUrl?: string,
): ProviderConfig {
  const config = loadProxyConfig();
  const url = proxyUrl || config.proxyUrl;

  return {
    name: "openrouter", // Proxy speaks OpenAI-compatible, same as openrouter
    model: model || "auto", // Let the proxy pick the best model
    baseURL: `${url}/v1`,
    apiKey: token, // Bearer token used as API key for OpenAI-compatible auth
    headers: getProxyHeaders(token, config.vesselId),
  };
}

// ============================================
// Vessel ID Management
// ============================================

/** Get the vessel ID for this install (auto-generates on first call). */
export function getVesselId(): string {
  const config = loadProxyConfig();
  return config.vesselId;
}

/** Get the proxy URL. */
export function getProxyUrl(): string {
  const config = loadProxyConfig();
  return config.proxyUrl;
}

/** Update the proxy URL. */
export function setProxyUrl(url: string): void {
  const config = loadProxyConfig();
  config.proxyUrl = url;
  saveProxyConfig(config);
}
