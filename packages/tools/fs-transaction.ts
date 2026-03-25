/**
 * FSTransaction - atomic filesystem transactions with rollback on failure.
 *
 * Usage:
 *   const tx = new FSTransaction();
 *   tx.write("file.txt", "hello");
 *   tx.delete("old.txt");
 *   tx.rename("a.txt", "b.txt");
 *   await tx.commit(); // atomic: temp-write then rename, rollback on error
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

type OpType = "write" | "delete" | "rename";

interface Op {
  type: OpType;
  path: string;
  dest?: string;
  content?: string;
  backup?: string;
}

interface JournalEntry {
  id: string;
  ts: number;
  ops: Op[];
  status: "pending" | "committed" | "rolled-back";
}

const JOURNAL_PATH = ".8gent/fs-tx-journal.json";

export class FSTransaction {
  private ops: Op[] = [];
  private id: string;

  constructor() {
    this.id = randomBytes(8).toString("hex");
  }

  /** Queue a file write (creates or overwrites). */
  write(path: string, content: string): this {
    this.ops.push({ type: "write", path, content });
    return this;
  }

  /** Queue a file deletion. */
  delete(path: string): this {
    this.ops.push({ type: "delete", path });
    return this;
  }

  /** Queue a file rename/move. */
  rename(from: string, to: string): this {
    this.ops.push({ type: "rename", path: from, dest: to });
    return this;
  }

  /** Commit all queued operations atomically. Rolls back on any failure. */
  async commit(): Promise<void> {
    this._writeJournal("pending");
    const applied: Op[] = [];
    try {
      for (const op of this.ops) {
        await this._apply(op);
        applied.push(op);
      }
      this._writeJournal("committed");
    } catch (err) {
      this._rollback(applied);
      this._writeJournal("rolled-back");
      throw new Error(
        `FSTransaction ${this.id} failed: ${(err as Error).message}. Rolled back ${applied.length} op(s).`
      );
    }
  }

  private async _apply(op: Op): Promise<void> {
    if (op.type === "write") {
      const tmpPath = op.path + ".tmp." + this.id;
      if (existsSync(op.path)) {
        const backupPath = op.path + ".bak." + this.id;
        renameSync(op.path, backupPath);
        op.backup = backupPath;
      }
      mkdirSync(dirname(op.path), { recursive: true });
      writeFileSync(tmpPath, op.content ?? "", "utf8");
      renameSync(tmpPath, op.path);
    } else if (op.type === "delete") {
      if (existsSync(op.path)) {
        const backupPath = op.path + ".bak." + this.id;
        renameSync(op.path, backupPath);
        op.backup = backupPath;
      }
    } else if (op.type === "rename") {
      if (!op.dest) throw new Error("rename op missing dest");
      if (existsSync(op.dest)) {
        const backupPath = op.dest + ".bak." + this.id;
        renameSync(op.dest, backupPath);
        op.backup = backupPath;
      }
      renameSync(op.path, op.dest);
    }
  }

  private _rollback(applied: Op[]): void {
    for (const op of [...applied].reverse()) {
      try {
        if (op.type === "write") {
          if (existsSync(op.path)) unlinkSync(op.path);
          if (op.backup && existsSync(op.backup)) renameSync(op.backup, op.path);
        } else if (op.type === "delete") {
          if (op.backup && existsSync(op.backup)) renameSync(op.backup, op.path);
        } else if (op.type === "rename") {
          if (op.dest && existsSync(op.dest)) renameSync(op.dest, op.path);
          if (op.backup && op.dest && existsSync(op.backup)) renameSync(op.backup, op.dest);
        }
      } catch {
        process.stderr.write(`FSTransaction rollback warning: could not revert op ${op.type} on ${op.path}\n`);
      }
    }
  }

  private _writeJournal(status: JournalEntry["status"]): void {
    try {
      mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
      let entries: JournalEntry[] = [];
      if (existsSync(JOURNAL_PATH)) {
        entries = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
      }
      const idx = entries.findIndex((e) => e.id === this.id);
      const entry: JournalEntry = { id: this.id, ts: Date.now(), ops: this.ops, status };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
      writeFileSync(JOURNAL_PATH, JSON.stringify(entries, null, 2), "utf8");
    } catch {
      // Non-fatal
    }
  }
}
