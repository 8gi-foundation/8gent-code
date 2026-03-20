/**
 * WorktreeAgent — ClawTeam pattern
 * Spawns sub-agents in isolated git worktrees with filesystem messaging.
 *
 * Each agent gets:
 * - Its own git worktree (isolated filesystem)
 * - A filesystem-based inbox for message passing
 * - Automatic timeout and cleanup
 * - Merge/PR capabilities when done
 */

import {
  execSync,
  spawn,
  ChildProcess,
} from "child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
} from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeAgentConfig {
  id: string;
  persona: string; // Winston, Larry, Curly, Mo, Doc
  task: string;
  parentBranch?: string;
  timeout?: number; // ms, default 600_000 (10 min)
}

export interface AgentMessage {
  from: string;
  to: string;
  type: "task" | "result" | "status" | "error" | "question";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface WorktreeAgentStatus {
  id: string;
  persona: string;
  branch: string;
  worktreePath: string;
  pid: number;
  status: "running" | "completed" | "failed" | "timeout";
  startedAt: number;
  completedAt?: number;
  filesChanged: string[];
  mergeReady: boolean;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WorktreeAgentManager {
  private projectRoot: string;
  private worktreeBase: string;
  private inboxBase: string;
  private agents: Map<string, WorktreeAgentStatus> = new Map();
  private processes: Map<string, ChildProcess> = new Map();

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
    this.worktreeBase = join(this.projectRoot, ".8gent", "worktrees");
    this.inboxBase = join(this.projectRoot, ".8gent", "inbox");
    mkdirSync(this.worktreeBase, { recursive: true });
    mkdirSync(this.inboxBase, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  /** Spawn a new agent in an isolated worktree */
  async spawn(config: WorktreeAgentConfig): Promise<WorktreeAgentStatus> {
    const { id, persona, task, parentBranch, timeout } = config;
    const branch = `agent/${id}`;
    const worktreePath = join(this.worktreeBase, id);
    const inboxPath = join(this.inboxBase, id);

    // Create inbox directory
    mkdirSync(inboxPath, { recursive: true });

    // Create git worktree
    const base = parentBranch || this.getCurrentBranch();
    try {
      execSync(
        `git worktree add "${worktreePath}" -b "${branch}" "${base}"`,
        { cwd: this.projectRoot, stdio: "pipe" },
      );
    } catch (err: any) {
      // Branch may already exist from a previous run
      if (err.stderr?.toString().includes("already exists")) {
        execSync(
          `git worktree add "${worktreePath}" "${branch}"`,
          { cwd: this.projectRoot, stdio: "pipe" },
        );
      } else {
        throw err;
      }
    }

    // Write task file so the child agent can read its assignment
    writeFileSync(
      join(inboxPath, "task.json"),
      JSON.stringify(
        {
          id,
          persona,
          task,
          parentBranch: base,
          createdAt: Date.now(),
        },
        null,
        2,
      ),
    );

    // Launch agent process inside the worktree
    const proc = spawn(
      "bun",
      [
        "run",
        "bin/8gent.ts",
        "chat",
        task,
        "--json",
        "--yes",
        `--cwd=${worktreePath}`,
      ],
      {
        cwd: this.projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          EIGHT_AGENT_ID: id,
          EIGHT_PERSONA: persona,
        },
        detached: true,
      },
    );

    // Stream stdout / stderr to a log file
    const logPath = join(inboxPath, "output.log");
    proc.stdout?.on("data", (d) => appendFileSync(logPath, d));
    proc.stderr?.on("data", (d) => appendFileSync(logPath, `[ERR] ${d}`));

    // Timeout handler
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      this.updateStatus(id, "timeout");
    }, timeout || 600_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const status: WorktreeAgentStatus["status"] =
        code === 0 ? "completed" : "failed";
      this.updateStatus(id, status);

      // Persist result alongside the task
      writeFileSync(
        join(inboxPath, "result.json"),
        JSON.stringify(
          {
            id,
            status,
            exitCode: code,
            filesChanged: this.getChangedFiles(worktreePath),
            completedAt: Date.now(),
          },
          null,
          2,
        ),
      );
    });

    const agentStatus: WorktreeAgentStatus = {
      id,
      persona,
      branch,
      worktreePath,
      pid: proc.pid!,
      status: "running",
      startedAt: Date.now(),
      filesChanged: [],
      mergeReady: false,
    };

    this.agents.set(id, agentStatus);
    this.processes.set(id, proc);
    return agentStatus;
  }

  // -------------------------------------------------------------------------
  // Messaging (filesystem-based)
  // -------------------------------------------------------------------------

  /** Send a message to an agent's inbox */
  sendMessage(
    agentId: string,
    message: Omit<AgentMessage, "timestamp">,
  ): void {
    const inboxPath = join(this.inboxBase, agentId);
    mkdirSync(inboxPath, { recursive: true });
    const msgFile = join(inboxPath, `msg-${Date.now()}.json`);
    writeFileSync(
      msgFile,
      JSON.stringify({ ...message, timestamp: Date.now() }, null, 2),
    );
  }

  /** Read messages from an agent's inbox (sorted chronologically) */
  readMessages(agentId: string): AgentMessage[] {
    const inboxPath = join(this.inboxBase, agentId);
    if (!existsSync(inboxPath)) return [];

    return readdirSync(inboxPath)
      .filter((f) => f.startsWith("msg-") && f.endsWith(".json"))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(inboxPath, f), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean) as AgentMessage[];
  }

  /** Consume (read + delete) messages from an agent's inbox */
  consumeMessages(agentId: string): AgentMessage[] {
    const inboxPath = join(this.inboxBase, agentId);
    if (!existsSync(inboxPath)) return [];

    const files = readdirSync(inboxPath).filter(
      (f) => f.startsWith("msg-") && f.endsWith(".json"),
    );
    const messages: AgentMessage[] = [];

    for (const f of files.sort()) {
      try {
        messages.push(
          JSON.parse(readFileSync(join(inboxPath, f), "utf-8")),
        );
        unlinkSync(join(inboxPath, f));
      } catch {
        /* skip corrupt files */
      }
    }
    return messages;
  }

  // -------------------------------------------------------------------------
  // Status / lifecycle
  // -------------------------------------------------------------------------

  /** Get status of all agents */
  listAgents(): WorktreeAgentStatus[] {
    return Array.from(this.agents.values());
  }

  /** Get status of a specific agent */
  getAgent(id: string): WorktreeAgentStatus | undefined {
    return this.agents.get(id);
  }

  /** Kill a running agent */
  kill(id: string): boolean {
    const proc = this.processes.get(id);
    if (proc) {
      proc.kill("SIGTERM");
      this.updateStatus(id, "failed");
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Merge / PR
  // -------------------------------------------------------------------------

  /** Merge a completed agent's branch back into the current branch */
  async merge(
    id: string,
    strategy: "merge" | "squash" = "squash",
  ): Promise<{ success: boolean; commitHash?: string; error?: string }> {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== "completed") {
      return { success: false, error: "Agent not completed" };
    }

    try {
      if (strategy === "squash") {
        execSync(`git merge --squash ${agent.branch}`, {
          cwd: this.projectRoot,
          stdio: "pipe",
        });
        execSync(
          `git commit -m "feat(${agent.persona}): ${agent.id}"`,
          { cwd: this.projectRoot, stdio: "pipe" },
        );
      } else {
        execSync(
          `git merge ${agent.branch} --no-ff -m "merge: agent/${agent.id}"`,
          { cwd: this.projectRoot, stdio: "pipe" },
        );
      }

      const hash = execSync("git rev-parse --short HEAD", {
        cwd: this.projectRoot,
        encoding: "utf-8",
      }).trim();

      return { success: true, commitHash: hash };
    } catch (err: any) {
      return { success: false, error: err.stderr?.toString() || err.message };
    }
  }

  /** Push the agent's branch and open a GitHub PR */
  async createPR(
    id: string,
  ): Promise<{ url?: string; error?: string }> {
    const agent = this.agents.get(id);
    if (!agent) return { error: "Agent not found" };

    try {
      execSync(`git push origin ${agent.branch}`, {
        cwd: this.projectRoot,
        stdio: "pipe",
      });
      const url = execSync(
        `gh pr create --title "feat(${agent.persona}): ${agent.id}" ` +
          `--body "Auto-generated by 8gent worktree agent" ` +
          `--head ${agent.branch}`,
        { cwd: this.projectRoot, encoding: "utf-8" },
      ).trim();
      return { url };
    } catch (err: any) {
      return { error: err.stderr?.toString() || err.message };
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove a worktree and its branch */
  cleanup(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;

    try {
      execSync(
        `git worktree remove "${agent.worktreePath}" --force`,
        { cwd: this.projectRoot, stdio: "pipe" },
      );
    } catch {
      /* best effort */
    }
    try {
      execSync(`git branch -D ${agent.branch}`, {
        cwd: this.projectRoot,
        stdio: "pipe",
      });
    } catch {
      /* best effort */
    }

    this.agents.delete(id);
    this.processes.delete(id);
  }

  /** Remove all worktrees and branches managed by this instance */
  cleanupAll(): void {
    for (const id of Array.from(this.agents.keys())) {
      this.cleanup(id);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getCurrentBranch(): string {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: this.projectRoot,
      encoding: "utf-8",
    }).trim();
  }

  private getChangedFiles(worktreePath: string): string[] {
    try {
      return execSync("git diff --name-only HEAD~1", {
        cwd: worktreePath,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private updateStatus(
    id: string,
    status: WorktreeAgentStatus["status"],
  ): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = status;
      if (status === "completed") {
        agent.completedAt = Date.now();
        agent.mergeReady = true;
        agent.filesChanged = this.getChangedFiles(agent.worktreePath);
      }
    }
  }
}
