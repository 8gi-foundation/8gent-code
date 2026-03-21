/**
 * WorktreeMessaging — filesystem-based message passing between agents.
 *
 * Messages are JSON files in .8gent/messages/<agentId>/.
 * No shared memory, no sockets - the filesystem is the bus.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { AgentMessage } from "./worktree-pool-types";

export class WorktreeMessaging {
  private base: string;

  constructor(projectRoot: string) {
    this.base = join(projectRoot, ".8gent", "messages");
    mkdirSync(this.base, { recursive: true });
  }

  send(message: Omit<AgentMessage, "id" | "timestamp">): AgentMessage {
    const msg: AgentMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };

    const targets = message.to === "broadcast"
      ? this.listInboxes()
      : [message.to];

    for (const target of targets) {
      const dir = join(this.base, target);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${msg.id}.json`), JSON.stringify(msg, null, 2));
    }

    return msg;
  }

  /** Read messages without removing them */
  peek(agentId: string): AgentMessage[] {
    return this.readDir(agentId, false);
  }

  /** Read and delete messages (consume) */
  consume(agentId: string): AgentMessage[] {
    return this.readDir(agentId, true);
  }

  private readDir(agentId: string, remove: boolean): AgentMessage[] {
    const dir = join(this.base, agentId);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    const messages: AgentMessage[] = [];

    for (const f of files) {
      const fp = join(dir, f);
      try {
        messages.push(JSON.parse(readFileSync(fp, "utf-8")));
        if (remove) unlinkSync(fp);
      } catch { /* skip corrupt */ }
    }

    return messages;
  }

  private listInboxes(): string[] {
    if (!existsSync(this.base)) return [];
    return readdirSync(this.base);
  }
}
