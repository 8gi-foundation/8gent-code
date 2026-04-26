/**
 * WorktreeManager — Git worktree lifecycle for isolated sub-agent sandboxes.
 *
 * Each sub-agent gets its own git worktree so it can read/write files
 * without affecting the main working directory. Changes are merged
 * only when the orchestrator (Eight) approves.
 */

import { exec } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface WorktreeInfo {
	agentId: string;
	path: string;
	branch: string;
	createdAt: Date;
	status: "active" | "merged" | "removed";
}

export class WorktreeManager {
	private workingDirectory: string;
	private worktreesDir: string;
	private worktrees: Map<string, WorktreeInfo> = new Map();

	constructor(workingDirectory: string = process.cwd()) {
		this.workingDirectory = resolve(workingDirectory);
		this.worktreesDir = join(this.workingDirectory, ".8gent", "worktrees");
	}

	/**
	 * Create an isolated git worktree for a sub-agent.
	 * Returns the absolute path to the worktree.
	 */
	async createWorktree(agentId: string, personaId: string, taskHint?: string): Promise<string> {
		// Ensure worktrees directory exists
		if (!existsSync(this.worktreesDir)) {
			mkdirSync(this.worktreesDir, { recursive: true });
		}

		const hash = crypto.randomBytes(4).toString("hex");
		const branchName = `agent/${personaId}-${hash}`;
		const worktreePath = join(this.worktreesDir, `${personaId}-${hash}`);

		try {
			// Create the worktree with a new branch from current HEAD
			await execAsync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
				cwd: this.workingDirectory,
				timeout: 15000,
			});

			const info: WorktreeInfo = {
				agentId,
				path: worktreePath,
				branch: branchName,
				createdAt: new Date(),
				status: "active",
			};

			this.worktrees.set(agentId, info);
			return worktreePath;
		} catch (err) {
			throw new Error(`Failed to create worktree: ${err instanceof Error ? err.message : err}`);
		}
	}

	/**
	 * Remove a worktree and optionally delete its branch.
	 */
	async removeWorktree(agentId: string, deleteBranch = true): Promise<void> {
		const info = this.worktrees.get(agentId);
		if (!info) return;

		try {
			await execAsync(`git worktree remove "${info.path}" --force`, {
				cwd: this.workingDirectory,
				timeout: 10000,
			});

			if (deleteBranch && info.status !== "merged") {
				await execAsync(`git branch -D "${info.branch}"`, {
					cwd: this.workingDirectory,
					timeout: 5000,
				}).catch(() => {}); // Branch may not exist if worktree was empty
			}

			info.status = "removed";
			this.worktrees.delete(agentId);
		} catch {
			// Force cleanup
			this.worktrees.delete(agentId);
		}
	}

	/**
	 * Get the diff of changes made in a worktree (for review before merge).
	 */
	async getChanges(agentId: string): Promise<string> {
		const info = this.worktrees.get(agentId);
		if (!info) return "";

		try {
			// Check if there are any commits on the branch
			const { stdout: log } = await execAsync(`git log --oneline HEAD..${info.branch}`, {
				cwd: this.workingDirectory,
				timeout: 5000,
			});

			if (!log.trim()) return ""; // No changes

			const { stdout } = await execAsync(`git diff HEAD...${info.branch}`, {
				cwd: this.workingDirectory,
				timeout: 10000,
			});
			return stdout;
		} catch {
			return "";
		}
	}

	/**
	 * Merge a worktree's changes into the main branch.
	 * Only the orchestrator should call this.
	 */
	async mergeWorktree(
		agentId: string,
		commitMessage?: string,
	): Promise<{ success: boolean; message: string }> {
		const info = this.worktrees.get(agentId);
		if (!info) return { success: false, message: "Worktree not found" };

		try {
			const changes = await this.getChanges(agentId);
			if (!changes) {
				await this.removeWorktree(agentId);
				return { success: true, message: "No changes to merge" };
			}

			const msg = commitMessage || `merge: ${info.branch} into main`;
			await execAsync(`git merge --no-ff "${info.branch}" -m "${msg}"`, {
				cwd: this.workingDirectory,
				timeout: 15000,
			});

			info.status = "merged";
			await this.removeWorktree(agentId, true);

			return { success: true, message: `Merged ${info.branch}` };
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			return { success: false, message: `Merge failed: ${errMsg}` };
		}
	}

	/**
	 * List all active worktrees.
	 */
	listWorktrees(): WorktreeInfo[] {
		return Array.from(this.worktrees.values());
	}

	/**
	 * Get worktree info for a specific agent.
	 */
	getWorktree(agentId: string): WorktreeInfo | undefined {
		return this.worktrees.get(agentId);
	}

	/**
	 * Clean up all worktrees (called on shutdown).
	 */
	async cleanupAll(): Promise<void> {
		const agents = Array.from(this.worktrees.keys());
		for (const agentId of agents) {
			await this.removeWorktree(agentId).catch(() => {});
		}
	}
}
