import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface CommandEntry {
  id: string;
  command: string;
  args: string[];
  result: string;
  exitCode: number;
  timestamp: number;
  durationMs: number;
  cwd: string;
}

export interface FrequencyEntry {
  command: string;
  count: number;
  lastUsed: number;
  avgExitCode: number;
}

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_HISTORY_PATH = join(process.env.HOME || "~", ".8gent", "command-history.json");

export class CommandHistory {
  private entries: CommandEntry[] = [];
  private filePath: string;
  private maxSize: number;

  constructor(filePath = DEFAULT_HISTORY_PATH, maxSize = DEFAULT_MAX_SIZE) {
    this.filePath = filePath;
    this.maxSize = maxSize;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      this.entries = JSON.parse(raw);
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
      if (!existsSync(dir)) {
        require("fs").mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
    } catch {
      // best-effort persist
    }
  }

  record(entry: Omit<CommandEntry, "id" | "timestamp">): CommandEntry {
    const full: CommandEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this.entries.push(full);
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(this.entries.length - this.maxSize);
    }
    this.save();
    return full;
  }

  search(query: string, limit = 20): CommandEntry[] {
    const q = query.toLowerCase();
    return this.entries
      .filter(
        (e) =>
          e.command.toLowerCase().includes(q) ||
          e.args.join(" ").toLowerCase().includes(q) ||
          e.result.toLowerCase().includes(q)
      )
      .slice(-limit)
      .reverse();
  }

  recent(limit = 20): CommandEntry[] {
    return [...this.entries].reverse().slice(0, limit);
  }

  frequency(topN = 10): FrequencyEntry[] {
    const map = new Map<string, { count: number; lastUsed: number; exitCodes: number[] }>();
    for (const e of this.entries) {
      const key = e.command;
      const existing = map.get(key) ?? { count: 0, lastUsed: 0, exitCodes: [] };
      existing.count++;
      existing.lastUsed = Math.max(existing.lastUsed, e.timestamp);
      existing.exitCodes.push(e.exitCode);
      map.set(key, existing);
    }
    return [...map.entries()]
      .map(([command, data]) => ({
        command,
        count: data.count,
        lastUsed: data.lastUsed,
        avgExitCode:
          data.exitCodes.reduce((a, b) => a + b, 0) / data.exitCodes.length,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  size(): number {
    return this.entries.length;
  }

  getById(id: string): CommandEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
}
