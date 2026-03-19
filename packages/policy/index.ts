/**
 * @8gent/policy — NemoClaw-inspired Policy Engine
 *
 * Security-first policy evaluation for agent actions.
 * Loads declarative YAML policies, evaluates actions against
 * allow/deny/requireApproval rules, and supports hot-reload.
 *
 * Key concepts from NemoClaw:
 * - Deny-by-default for sensitive operations
 * - Declarative policy files (YAML)
 * - Approval gates for destructive actions
 * - Privacy-aware model routing (local vs cloud)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parsePolicy, getDefaultPolicy, matchesAnyPattern, matchesPattern } from "./parser.js";
import { ApprovalGate, formatApprovalRequest } from "./approval.js";
import { PrivacyAwareRouter } from "./model-router.js";
import type { Policy, PolicyAction, PolicyDecision, ModelChoice } from "./schema.js";

// Re-export all types and utilities
export { parsePolicy, getDefaultPolicy, matchesPattern, matchesAnyPattern } from "./parser.js";
export { ApprovalGate, formatApprovalRequest } from "./approval.js";
export { PrivacyAwareRouter } from "./model-router.js";
export type {
  Policy,
  PolicyAction,
  PolicyDecision,
  PolicyRules,
  FilesystemRules,
  CommandRules,
  NetworkRules,
  InferenceRules,
  ActionType,
  ApprovalRecord,
  ModelChoice,
  ModelProvider,
} from "./schema.js";

// ============================================
// Policy Engine
// ============================================

export class PolicyEngine {
  private policy: Policy;
  private policyPath: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private approvalGate: ApprovalGate;
  private modelRouter: PrivacyAwareRouter;
  private onReload?: (policy: Policy) => void;

  constructor(options?: {
    policy?: Policy;
    approvalGate?: ApprovalGate;
    modelRouter?: PrivacyAwareRouter;
    onReload?: (policy: Policy) => void;
  }) {
    this.policy = options?.policy ?? getDefaultPolicy();
    this.approvalGate = options?.approvalGate ?? new ApprovalGate();
    this.modelRouter = options?.modelRouter ?? new PrivacyAwareRouter();
    this.onReload = options?.onReload;
  }

  /**
   * Load policy from the standard locations:
   * 1. .8gent/policy.yaml (project-local)
   * 2. ~/.8gent/policy.yaml (user-global)
   * 3. Fall back to built-in defaults
   *
   * Optionally starts a file watcher for hot-reload.
   */
  static async fromFile(options?: {
    projectRoot?: string;
    watch?: boolean;
    approvalGate?: ApprovalGate;
    modelRouter?: PrivacyAwareRouter;
    onReload?: (policy: Policy) => void;
  }): Promise<PolicyEngine> {
    const engine = new PolicyEngine({
      approvalGate: options?.approvalGate,
      modelRouter: options?.modelRouter,
      onReload: options?.onReload,
    });

    const projectRoot = options?.projectRoot ?? process.cwd();
    const candidates = [
      path.join(projectRoot, ".8gent", "policy.yaml"),
      path.join(os.homedir(), ".8gent", "policy.yaml"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        engine.loadFromPath(candidate);
        if (options?.watch) {
          engine.startWatching();
        }
        return engine;
      }
    }

    // No policy file found — use defaults
    engine.policy = getDefaultPolicy();
    return engine;
  }

  /**
   * Evaluate an action against the loaded policy.
   * Returns a decision with allowed/denied status and reasoning.
   */
  evaluate(action: PolicyAction): PolicyDecision {
    switch (action.type) {
      case "file_read":
      case "file_write":
      case "file_delete":
        return this.evaluateFilesystem(action);
      case "command":
        return this.evaluateCommand(action);
      case "network":
        return this.evaluateNetwork(action);
      case "git_push":
        return this.evaluateGitPush(action);
      case "git_force_push":
        return this.evaluateGitForcePush(action);
      default:
        return { allowed: false, reason: `Unknown action type: ${action.type}` };
    }
  }

  /**
   * Evaluate and optionally prompt for approval if the action requires it.
   * Combines evaluate() with the approval gate.
   */
  async evaluateWithApproval(action: PolicyAction): Promise<PolicyDecision> {
    const decision = this.evaluate(action);

    if (decision.requiresApproval && decision.allowed) {
      const reason = decision.reason ?? "Policy requires approval for this action";
      const approved = await this.approvalGate.requestApproval(action, reason);

      if (!approved) {
        return {
          allowed: false,
          reason: "User denied approval",
          alternatives: decision.alternatives,
        };
      }
    }

    return decision;
  }

  /**
   * Route a model request based on file privacy.
   */
  routeModel(prompt: string, filePaths: string[]): ModelChoice {
    return this.modelRouter.routeRequest(prompt, filePaths, this.policy);
  }

  /**
   * Get the current loaded policy.
   */
  getPolicy(): Readonly<Policy> {
    return this.policy;
  }

  /**
   * Get the approval gate for audit access.
   */
  getApprovalGate(): ApprovalGate {
    return this.approvalGate;
  }

  /**
   * Stop watching the policy file for changes.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Clean up resources (stop file watcher).
   */
  dispose(): void {
    this.stopWatching();
  }

  // ============================================
  // Private: Evaluation Logic
  // ============================================

  private evaluateFilesystem(action: PolicyAction): PolicyDecision {
    const rules = this.policy.rules.filesystem;
    const target = action.target;

    // Deny takes priority
    if (matchesAnyPattern(target, rules.deny)) {
      return {
        allowed: false,
        reason: `Path "${target}" matches a deny pattern in filesystem rules`,
        alternatives: action.type === "file_write"
          ? ["Write to a different location outside denied paths"]
          : undefined,
      };
    }

    // Check requireApproval
    if (matchesAnyPattern(target, rules.requireApproval)) {
      // Allow but flag for approval
      return {
        allowed: true,
        requiresApproval: true,
        reason: `Path "${target}" requires approval before ${action.type}`,
      };
    }

    // Check allow
    if (matchesAnyPattern(target, rules.allow)) {
      return { allowed: true };
    }

    // Default: deny (security-first)
    return {
      allowed: false,
      reason: `Path "${target}" is not in any allow pattern — denied by default`,
      alternatives: ["Add the path to filesystem.allow in your policy.yaml"],
    };
  }

  private evaluateCommand(action: PolicyAction): PolicyDecision {
    const rules = this.policy.rules.commands;
    const cmd = action.target;

    // Deny takes priority
    if (matchesAnyPattern(cmd, rules.deny)) {
      return {
        allowed: false,
        reason: `Command "${cmd}" matches a deny pattern`,
        alternatives: this.suggestCommandAlternatives(cmd),
      };
    }

    // Check requireApproval
    if (matchesAnyPattern(cmd, rules.requireApproval)) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `Command "${cmd}" requires approval before execution`,
      };
    }

    // Check allow
    if (matchesAnyPattern(cmd, rules.allow)) {
      return { allowed: true };
    }

    // Default: deny
    return {
      allowed: false,
      reason: `Command "${cmd}" is not in any allow pattern — denied by default`,
      alternatives: ["Add the command pattern to commands.allow in your policy.yaml"],
    };
  }

  private evaluateNetwork(action: PolicyAction): PolicyDecision {
    const rules = this.policy.rules.network;
    const target = action.target;

    // Check allow first (network is deny-by-default via wildcard)
    if (matchesAnyPattern(target, rules.allow)) {
      return { allowed: true };
    }

    // Deny
    if (matchesAnyPattern(target, rules.deny)) {
      return {
        allowed: false,
        reason: `Network access to "${target}" is denied by policy`,
        alternatives: ["Add the host to network.allow in your policy.yaml"],
      };
    }

    // Default: deny for network
    return {
      allowed: false,
      reason: `Network access to "${target}" — denied by default`,
    };
  }

  private evaluateGitPush(action: PolicyAction): PolicyDecision {
    // Git push is generally allowed if git commands are allowed
    const cmdDecision = this.evaluateCommand({ type: "command", target: `git push ${action.target}` });
    return cmdDecision;
  }

  private evaluateGitForcePush(action: PolicyAction): PolicyDecision {
    // Force push always requires approval
    return {
      allowed: true,
      requiresApproval: true,
      reason: `Force push to "${action.target}" is a destructive operation`,
      alternatives: ["Use regular git push instead", "Rebase and push normally"],
    };
  }

  private suggestCommandAlternatives(cmd: string): string[] {
    const alternatives: string[] = [];
    if (cmd.startsWith("rm -rf")) {
      alternatives.push("Use trash-cli or move files to /tmp instead");
    }
    if (cmd.startsWith("sudo")) {
      alternatives.push("Run without sudo if possible, or add specific commands to the allow list");
    }
    if (cmd.includes("| bash") || cmd.includes("| sh")) {
      alternatives.push("Download the script first, review it, then execute");
    }
    return alternatives;
  }

  // ============================================
  // Private: File Loading & Watching
  // ============================================

  private loadFromPath(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      this.policy = parsePolicy(content);
      this.policyPath = filePath;
    } catch (err) {
      console.error(`[policy] Failed to load ${filePath}: ${err}`);
      this.policy = getDefaultPolicy();
    }
  }

  private startWatching(): void {
    if (!this.policyPath) return;

    try {
      this.watcher = fs.watch(this.policyPath, (eventType) => {
        if (eventType === "change") {
          this.reloadPolicy();
        }
      });

      // Handle watcher errors gracefully
      this.watcher.on("error", (err) => {
        console.error(`[policy] File watcher error: ${err}`);
        this.stopWatching();
      });
    } catch (err) {
      console.error(`[policy] Could not watch ${this.policyPath}: ${err}`);
    }
  }

  private reloadPolicy(): void {
    if (!this.policyPath) return;

    try {
      const content = fs.readFileSync(this.policyPath, "utf-8");
      const newPolicy = parsePolicy(content);
      this.policy = newPolicy;
      this.onReload?.(newPolicy);
    } catch (err) {
      console.error(`[policy] Hot-reload failed: ${err}`);
      // Keep the previously loaded policy
    }
  }
}
