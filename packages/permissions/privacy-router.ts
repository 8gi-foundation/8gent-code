/**
 * 8gent Code - NemoClaw Privacy-Aware Model Router
 *
 * Detects when the agent touches sensitive files (secrets, keys, credentials)
 * and forces routing to a local model to prevent data leakage to cloud APIs.
 *
 * Part of the NemoClaw permission system - privacy is a first-class constraint.
 */

// ============================================
// Sensitive file patterns
// ============================================

const SENSITIVE_PATTERNS: RegExp[] = [
  /\.env($|\.)/i,                    // .env, .env.local, .env.production
  /\.pem$/i,                         // TLS/SSH certificates
  /id_rsa/i,                         // SSH private keys
  /id_ed25519/i,                     // SSH ed25519 keys
  /id_ecdsa/i,                       // SSH ecdsa keys
  /credentials/i,                    // credentials.json, .credentials
  /\.secret/i,                       // .secret, secrets.yaml
  /secrets?\.(json|ya?ml|toml)/i,    // secrets.json, secret.yaml
  /tokens?\.(json|ya?ml|txt)/i,      // token.json, tokens.yaml
  /\.key$/i,                         // private.key, server.key
  /keyfile/i,                        // keyfile.json
  /service[_-]?account/i,            // service_account.json (GCP)
  /\.pfx$/i,                         // PKCS#12 certificates
  /\.p12$/i,                         // PKCS#12 certificates
  /kubeconfig/i,                     // Kubernetes config with cluster creds
  /\.npmrc$/i,                       // npm auth tokens
  /\.pypirc$/i,                      // PyPI auth tokens
];

/** Cloud providers that send data off-machine */
const CLOUD_PROVIDERS = new Set(["openrouter"]);

/** Local providers that keep data on-device */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

const DEFAULT_LOCAL_MODEL = "qwen3.5:latest";

// ============================================
// Public API
// ============================================

/**
 * Check if any file path in the set matches a sensitive pattern.
 * Used to detect when the agent is operating on secrets/keys/credentials.
 */
export function isSensitiveContext(filePaths: string[]): boolean {
  return filePaths.some((fp) =>
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(fp))
  );
}

/**
 * If the current provider is cloud-based, return a local Ollama fallback.
 * Returns null if already using a local provider.
 */
export function forceLocalModel(
  currentProvider: string
): { model: string; provider: string } | null {
  if (LOCAL_PROVIDERS.has(currentProvider)) return null;
  return { model: DEFAULT_LOCAL_MODEL, provider: "ollama" };
}

/**
 * Privacy gate - the single entry point for the agent loop.
 *
 * Given the file paths touched in recent tool calls and the current provider,
 * decides whether to force a local model switch to protect sensitive data.
 */
export function privacyGate(
  filePaths: string[],
  currentProvider: string
): { shouldForceLocal: boolean; reason?: string } {
  if (!isSensitiveContext(filePaths)) {
    return { shouldForceLocal: false };
  }

  if (LOCAL_PROVIDERS.has(currentProvider)) {
    return { shouldForceLocal: false };
  }

  const matched = filePaths.filter((fp) =>
    SENSITIVE_PATTERNS.some((p) => p.test(fp))
  );

  return {
    shouldForceLocal: true,
    reason: `Sensitive files detected: ${matched.join(", ")} - forcing local model to prevent data leakage`,
  };
}
