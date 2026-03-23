/**
 * Chief of Staff Router - CEO command interface for Telegram.
 *
 * Intercepts CEO commands before they hit the generic agent.
 * Handles delegation, status tracking, planning, and governance.
 *
 * Commands:
 *   /delegate <task> [--repo <repo>] [--p0|--p1|--p2]
 *   /status
 *   /review
 *   /plan <task>
 *   /goals [set <goal>]
 *   /kill <task-id>
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createTask,
  updateTask,
  getTask,
  listTasks,
  getActiveTasks,
  getTasksByStatus,
  type CEOTask,
  type TaskPriority,
} from "./task-registry";
import { bus } from "./events";
import type { AgentPool } from "./agent-pool";
import type { NotificationDispatcher } from "./notifications";

const GOALS_PATH = join(process.env.HOME || "/root", ".8gent", "goals.json");
const WORKSPACE = join(process.env.HOME || "/root", ".8gent", "workspace");

interface CoSConfig {
  pool: AgentPool;
  notifications: NotificationDispatcher;
}

export class CoSRouter {
  private pool: AgentPool;
  private notifications: NotificationDispatcher;

  constructor(config: CoSConfig) {
    this.pool = config.pool;
    this.notifications = config.notifications;

    // Subscribe to task events for proactive notifications
    bus.on("task:completed", (payload: any) => {
      this.notifications.notify(
        "task-complete",
        `*Task Complete*\n\n${payload.description || payload.taskId}\n\nResult: ${(payload.result || "Done").slice(0, 500)}`
      );
    });

    bus.on("task:failed", (payload: any) => {
      this.notifications.notify(
        "task-failed",
        `*Task Failed*\n\n${payload.taskId}\n\nError: ${payload.error}`
      );
    });
  }

  /**
   * Try to handle a CEO command. Returns true if handled, false if should fall through to agent.
   */
  async handleCommand(text: string, chatId: number): Promise<boolean> {
    const trimmed = text.trim();

    if (trimmed.startsWith("/delegate ")) {
      await this.handleDelegate(trimmed.slice(10).trim());
      return true;
    }

    if (trimmed === "/status") {
      await this.handleStatus();
      return true;
    }

    if (trimmed === "/review") {
      await this.handleReview();
      return true;
    }

    if (trimmed.startsWith("/plan ")) {
      await this.handlePlan(trimmed.slice(6).trim());
      return true;
    }

    if (trimmed.startsWith("/goals")) {
      await this.handleGoals(trimmed.slice(6).trim());
      return true;
    }

    if (trimmed.startsWith("/kill ")) {
      await this.handleKill(trimmed.slice(6).trim());
      return true;
    }

    // Not a CEO command - fall through to agent
    return false;
  }

  private async handleDelegate(input: string): Promise<void> {
    // Parse flags
    let repo = "8gent-code";
    let priority: TaskPriority = "p1";
    let description = input;

    const repoMatch = input.match(/--repo\s+(\S+)/);
    if (repoMatch) {
      repo = repoMatch[1];
      description = description.replace(repoMatch[0], "").trim();
    }

    if (input.includes("--p0")) {
      priority = "p0";
      description = description.replace("--p0", "").trim();
    } else if (input.includes("--p2")) {
      priority = "p2";
      description = description.replace("--p2", "").trim();
    }

    // 1. Create task
    const task = createTask(description, priority, repo);
    bus.emit("task:created", { taskId: task.id, description });

    await this.notifications.notify(
      "task-created",
      `*Delegated*: ${description}\n\nID: \`${task.id}\`\nRepo: ${repo}\nPriority: ${priority}`
    );

    // 2. Create GitHub issue
    const repoPath = join(WORKSPACE, repo);
    let issueUrl = "";
    let issueNumber = 0;

    if (existsSync(repoPath)) {
      try {
        const result = execSync(
          `cd "${repoPath}" && gh issue create --title "${description.replace(/"/g, '\\"')}" --body "Delegated by CEO via Telegram.\n\nTask ID: ${task.id}\nPriority: ${priority}"`,
          { encoding: "utf-8", timeout: 15000 }
        ).trim();

        // gh issue create returns the URL
        issueUrl = result;
        const numMatch = result.match(/\/(\d+)$/);
        if (numMatch) issueNumber = parseInt(numMatch[1], 10);

        updateTask(task.id, {
          githubIssue: { number: issueNumber, url: issueUrl, repo },
        });

        await this.notifications.notify(
          "task-progress",
          `GitHub issue created: ${issueUrl}`
        );
      } catch (err) {
        console.error("[cos-router] failed to create GitHub issue:", err);
        await this.notifications.notify(
          "task-progress",
          `Could not create GitHub issue (continuing without it)`
        );
      }
    }

    // 3. Spawn subagent session to work on the task
    updateTask(task.id, { status: "delegated" });
    bus.emit("task:delegated", { taskId: task.id, description });

    const sessionId = `delegate_${task.id}`;
    this.pool.createSession(sessionId, "delegation");

    // Build delegation prompt with context
    const goals = this.loadGoals();
    const goalsContext = goals.length > 0
      ? `\n\nCompany objectives:\n${goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}`
      : "";

    const delegationPrompt = [
      `You are Eight, working on a delegated task from the CEO.`,
      ``,
      `Task: ${description}`,
      `Repository: ${repoPath}`,
      `GitHub Issue: ${issueUrl || "none"}`,
      `Priority: ${priority}`,
      goalsContext,
      ``,
      `Instructions:`,
      `1. cd to ${repoPath}`,
      `2. Create a feature branch for this work`,
      `3. Implement the task`,
      `4. Commit with conventional commit messages`,
      `5. Push the branch`,
      `6. Create a PR if code was changed`,
      `7. Summarize what you did`,
    ].join("\n");

    // Execute the delegation asynchronously
    updateTask(task.id, { status: "in-progress", subagentId: sessionId });

    // Give the agent time to initialize
    setTimeout(async () => {
      try {
        const response = await this.pool.chat(sessionId, delegationPrompt);
        updateTask(task.id, { status: "done", result: response });
        bus.emit("task:completed", {
          taskId: task.id,
          description,
          result: response,
          sessionId,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        updateTask(task.id, { status: "failed", result: error });
        bus.emit("task:failed", { taskId: task.id, error, sessionId });
      }
    }, 8000); // Wait for agent init
  }

  private async handleStatus(): Promise<void> {
    const active = getActiveTasks();
    const recent = listTasks(5);

    if (active.length === 0 && recent.length === 0) {
      await this.notifications.notify("task-progress", "*Status*: No tasks yet. Use /delegate to assign work.");
      return;
    }

    let msg = "*Eight - Task Status*\n\n";

    if (active.length > 0) {
      msg += "*Active:*\n";
      for (const t of active) {
        const icon = t.status === "in-progress" ? "+" : t.status === "delegated" ? ">" : "-";
        msg += `${icon} \`${t.id}\` [${t.status}] ${t.description.slice(0, 60)}\n`;
        if (t.githubIssue) msg += `  Issue: ${t.githubIssue.url}\n`;
      }
      msg += "\n";
    }

    const done = recent.filter((t) => t.status === "done" || t.status === "failed");
    if (done.length > 0) {
      msg += "*Recent:*\n";
      for (const t of done.slice(0, 3)) {
        const icon = t.status === "done" ? "v" : "x";
        msg += `${icon} \`${t.id}\` [${t.status}] ${t.description.slice(0, 60)}\n`;
      }
    }

    await this.notifications.notify("task-progress", msg);
  }

  private async handleReview(): Promise<void> {
    const review = getTasksByStatus("review");
    const done = getTasksByStatus("done");

    let msg = "*Review Queue*\n\n";

    if (review.length === 0 && done.length === 0) {
      msg += "No tasks awaiting review.";
    } else {
      for (const t of [...review, ...done].slice(0, 5)) {
        msg += `*${t.description.slice(0, 80)}*\n`;
        msg += `Status: ${t.status} | ID: \`${t.id}\`\n`;
        if (t.githubPR) msg += `PR: ${t.githubPR.url}\n`;
        if (t.githubIssue) msg += `Issue: ${t.githubIssue.url}\n`;
        if (t.result) msg += `Result: ${t.result.slice(0, 200)}\n`;
        msg += "\n";
      }
    }

    await this.notifications.notify("task-progress", msg);
  }

  private async handlePlan(description: string): Promise<void> {
    await this.notifications.notify(
      "task-progress",
      `*Planning:* ${description}\n\nDecomposing into steps...`
    );

    // Use the agent to create a BMAD plan without executing
    const sessionId = `plan_${Date.now().toString(36)}`;
    this.pool.createSession(sessionId, "planning");

    setTimeout(async () => {
      try {
        const response = await this.pool.chat(
          sessionId,
          `Create a BMAD implementation plan for this task. Break it into numbered steps. Do NOT execute anything - just plan.\n\nTask: ${description}`
        );
        await this.notifications.notify("task-progress", `*Plan for:* ${description}\n\n${response}`);
        this.pool.destroySession(sessionId);
      } catch (err) {
        await this.notifications.notify("error", `Planning failed: ${err}`);
        this.pool.destroySession(sessionId);
      }
    }, 8000);
  }

  private async handleGoals(input: string): Promise<void> {
    if (input.startsWith("set ")) {
      const goal = input.slice(4).trim();
      const goals = this.loadGoals();
      goals.push(goal);
      this.saveGoals(goals);
      await this.notifications.notify(
        "task-progress",
        `*Goal added:* ${goal}\n\nTotal: ${goals.length} objectives`
      );
      return;
    }

    if (input === "clear") {
      this.saveGoals([]);
      await this.notifications.notify("task-progress", "*Goals cleared.*");
      return;
    }

    const goals = this.loadGoals();
    if (goals.length === 0) {
      await this.notifications.notify(
        "task-progress",
        "*No goals set.*\n\nUse `/goals set <objective>` to add one."
      );
      return;
    }

    let msg = "*Company Objectives*\n\n";
    goals.forEach((g, i) => {
      msg += `${i + 1}. ${g}\n`;
    });
    await this.notifications.notify("task-progress", msg);
  }

  private async handleKill(taskId: string): Promise<void> {
    const task = getTask(taskId.trim());
    if (!task) {
      await this.notifications.notify("error", `Task \`${taskId}\` not found.`);
      return;
    }

    if (task.subagentId) {
      this.pool.destroySession(task.subagentId);
    }
    updateTask(task.id, { status: "failed", result: "Killed by CEO" });

    await this.notifications.notify(
      "task-progress",
      `*Killed:* \`${task.id}\` - ${task.description.slice(0, 60)}`
    );
  }

  private loadGoals(): string[] {
    try {
      if (existsSync(GOALS_PATH)) {
        return JSON.parse(readFileSync(GOALS_PATH, "utf-8"));
      }
    } catch {}
    return [];
  }

  private saveGoals(goals: string[]): void {
    writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
  }
}
