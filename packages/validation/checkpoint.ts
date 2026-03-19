/**
 * Checkpoint Manager — State snapshots for recovery
 *
 * Creates checkpoints of git state + file hashes + conversation position
 * before risky operations (deletes, force pushes, large refactors).
 * Restoring a checkpoint stashes current work and restores the snapshot.
 *
 * Storage: ~/.8gent/checkpoints/
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  label: string;
  gitBranch: string;
  gitCommit: string;
  fileHashes: Record<string, string>;
  conversationIndex: number;
  createdAt: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CHECKPOINTS_DIR = join(homedir(), ".8gent", "checkpoints");

// ── Helpers ────────────────────────────────────────────────────────────────

async function exec(cmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

function hashFile(filepath: string): string {
  try {
    const content = readFileSync(filepath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

// ── CheckpointManager ─────────────────────────────────────────────────────

export class CheckpointManager {
  private checkpointsDir: string;

  constructor(checkpointsDir: string = CHECKPOINTS_DIR) {
    this.checkpointsDir = checkpointsDir;
    mkdirSync(this.checkpointsDir, { recursive: true });
  }

  /**
   * Create a checkpoint: snapshot git branch, commit, tracked file hashes,
   * and the current conversation position.
   */
  async createCheckpoint(label: string, conversationIndex: number = 0): Promise<Checkpoint> {
    const id = randomUUID().slice(0, 12);
    const gitBranch = await exec("git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached'");
    const gitCommit = await exec("git rev-parse HEAD 2>/dev/null || echo 'no-commit'");

    // Hash all tracked files
    const trackedRaw = await exec("git ls-files 2>/dev/null || echo ''");
    const trackedFiles = trackedRaw.split("\n").filter(Boolean);
    const fileHashes: Record<string, string> = {};
    for (const file of trackedFiles) {
      fileHashes[file] = hashFile(file);
    }

    const checkpoint: Checkpoint = {
      id,
      label,
      gitBranch,
      gitCommit,
      fileHashes,
      conversationIndex,
      createdAt: new Date().toISOString(),
    };

    const filepath = join(this.checkpointsDir, `${id}.json`);
    writeFileSync(filepath, JSON.stringify(checkpoint, null, 2), "utf-8");

    return checkpoint;
  }

  /**
   * Restore a checkpoint: stash current changes, checkout the branch
   * and commit from the checkpoint.
   */
  async restoreCheckpoint(id: string): void {
    const checkpoint = this.getCheckpoint(id);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${id} not found`);
    }

    // Stash any current work
    await exec("git stash push -m '8gent-checkpoint-restore' 2>/dev/null || true");

    // Checkout the branch and commit
    if (checkpoint.gitBranch !== "detached") {
      await exec(`git checkout ${checkpoint.gitBranch} 2>/dev/null || true`);
    }
    await exec(`git checkout ${checkpoint.gitCommit} 2>/dev/null || true`);
  }

  /** List all checkpoints, sorted by creation time (newest first). */
  listCheckpoints(): Checkpoint[] {
    if (!existsSync(this.checkpointsDir)) return [];

    return readdirSync(this.checkpointsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const raw = readFileSync(join(this.checkpointsDir, f), "utf-8");
          return JSON.parse(raw) as Checkpoint;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b!.createdAt).getTime() - new Date(a!.createdAt).getTime(),
      ) as Checkpoint[];
  }

  /** Delete a checkpoint by ID. */
  deleteCheckpoint(id: string): void {
    const filepath = join(this.checkpointsDir, `${id}.json`);
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  }

  /** Get a single checkpoint by ID. */
  private getCheckpoint(id: string): Checkpoint | null {
    const filepath = join(this.checkpointsDir, `${id}.json`);
    if (!existsSync(filepath)) return null;
    try {
      const raw = readFileSync(filepath, "utf-8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }
}
