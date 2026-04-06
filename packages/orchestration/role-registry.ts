export interface RunnerConfig {
  role: string
  systemPrompt: string
  allowedTools: string[]
  retryPolicy: { maxAttempts: number; backoffMs: number }
  inferenceMode?: "ollama" | "lmstudio" | "openrouter" | "apfel"
  model?: string
}

export const ROLE_REGISTRY: Record<string, RunnerConfig> = {
  orchestrator: {
    role: "orchestrator",
    systemPrompt: "You are the Orchestrator. Plan, delegate, and coordinate. Think before acting. No code — direct others.",
    allowedTools: ["write_notes", "gh_issue_create", "gh_pr_list", "gh_issue_list"],
    retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
  },
  engineer: {
    role: "engineer",
    systemPrompt: "You are the Engineer. Write code, edit files, run commands. Implement exactly what is asked. No fluff.",
    allowedTools: ["read_file", "write_file", "edit_file", "list_files", "run_command", "git_status", "git_diff", "git_add", "git_commit", "git_push", "git_branch", "git_checkout", "get_outline", "get_symbol", "search_symbols"],
    retryPolicy: { maxAttempts: 3, backoffMs: 2000 },
  },
  qa: {
    role: "qa",
    systemPrompt: "You are QA. Find bugs, review diffs, run tests. Be harsh. Reject anything that doesn't meet the spec.",
    allowedTools: ["read_file", "list_files", "run_command", "git_diff", "git_status", "git_log", "get_outline"],
    retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
  },
}

export function getRunnerConfig(role: string): RunnerConfig {
  return ROLE_REGISTRY[role] ?? ROLE_REGISTRY.engineer
}
