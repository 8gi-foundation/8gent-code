/**
 * @8gent/policy — Privacy-Aware Model Router
 *
 * Routes inference requests to local or cloud models based on
 * the sensitivity of referenced files. Prevents accidental
 * leakage of secrets, credentials, and private data to cloud APIs.
 */

import * as path from "path";
import { matchesAnyPattern } from "./parser.js";
import type { Policy, ModelChoice, ModelProvider } from "./schema.js";

// ============================================
// Privacy-Aware Router
// ============================================

export class PrivacyAwareRouter {
  private defaultLocalModel: string;
  private defaultCloudModel: string;

  constructor(options?: { localModel?: string; cloudModel?: string }) {
    this.defaultLocalModel = options?.localModel ?? "qwen2.5-coder:7b";
    this.defaultCloudModel = options?.cloudModel ?? "anthropic/claude-sonnet-4-20250514";
  }

  /**
   * Determine whether a request should be routed to a local or cloud model
   * based on the privacy sensitivity of referenced files.
   *
   * Priority order:
   * 1. If ANY file matches localOnly patterns -> force local
   * 2. If ALL files match cloudAllowed patterns -> allow cloud
   * 3. Default -> local (safe fallback)
   */
  routeRequest(prompt: string, filePaths: string[], policy: Policy): ModelChoice {
    const inference = policy.rules.inference;

    // No files referenced — check the prompt itself for sensitive patterns
    if (filePaths.length === 0) {
      const hasSensitiveContent = this.promptContainsSensitivePatterns(prompt);
      if (hasSensitiveContent) {
        return {
          provider: "local",
          model: this.defaultLocalModel,
          reason: "Prompt contains potentially sensitive content (secrets, credentials, tokens)",
        };
      }
      return {
        provider: "cloud",
        model: this.defaultCloudModel,
        reason: "No files referenced and prompt appears safe for cloud processing",
      };
    }

    // Check if ANY file matches localOnly patterns
    const sensitiveFiles = filePaths.filter((fp) => {
      const basename = path.basename(fp);
      return (
        matchesAnyPattern(fp, inference.localOnly) ||
        matchesAnyPattern(basename, inference.localOnly)
      );
    });

    if (sensitiveFiles.length > 0) {
      return {
        provider: "local",
        model: this.defaultLocalModel,
        reason: `Sensitive file(s) detected: ${sensitiveFiles.slice(0, 3).join(", ")}${sensitiveFiles.length > 3 ? ` (+${sensitiveFiles.length - 3} more)` : ""}`,
      };
    }

    // Check if ALL files match cloudAllowed patterns
    const allCloudSafe = filePaths.every((fp) => {
      const basename = path.basename(fp);
      return (
        matchesAnyPattern(fp, inference.cloudAllowed) ||
        matchesAnyPattern(basename, inference.cloudAllowed)
      );
    });

    if (allCloudSafe) {
      return {
        provider: "cloud",
        model: this.defaultCloudModel,
        reason: "All referenced files match cloud-allowed patterns",
      };
    }

    // Default: local (safe fallback)
    const unknownFiles = filePaths.filter((fp) => {
      const basename = path.basename(fp);
      return (
        !matchesAnyPattern(fp, inference.cloudAllowed) &&
        !matchesAnyPattern(basename, inference.cloudAllowed)
      );
    });

    return {
      provider: "local",
      model: this.defaultLocalModel,
      reason: `Unknown file sensitivity for: ${unknownFiles.slice(0, 3).join(", ")}${unknownFiles.length > 3 ? ` (+${unknownFiles.length - 3} more)` : ""} — defaulting to local`,
    };
  }

  /**
   * Quick check for obviously sensitive content in prompts.
   */
  private promptContainsSensitivePatterns(prompt: string): boolean {
    const sensitiveKeywords = [
      "API_KEY",
      "SECRET_KEY",
      "PRIVATE_KEY",
      "PASSWORD",
      "ACCESS_TOKEN",
      "REFRESH_TOKEN",
      "DATABASE_URL",
      "-----BEGIN",
      "ssh-rsa",
      "ssh-ed25519",
    ];
    const upper = prompt.toUpperCase();
    return sensitiveKeywords.some((kw) => upper.includes(kw));
  }
}
