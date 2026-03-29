/** @8gent/channels - Channel Router */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ChannelAdapter, ChannelConfig, ChannelMessage } from "./types";

function parseSimpleYaml(raw: string): Record<string, ChannelConfig> {
  const configs: Record<string, ChannelConfig> = {};
  let current: Partial<ChannelConfig> & { key?: string } = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && trimmed.endsWith(":")) {
      if (current.key && current.platform) {
        configs[current.key] = { platform: current.platform, enabled: current.enabled ?? true, token: current.token, webhookUrl: current.webhookUrl };
      }
      current = { key: trimmed.slice(0, -1) };
      continue;
    }
    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (!match) continue;
    const [, k, v] = match;
    const val = v.replace(/^["']|["']$/g, "");
    if (k === "platform") current.platform = val as ChannelConfig["platform"];
    else if (k === "enabled") current.enabled = val === "true";
    else if (k === "token") current.token = val;
    else if (k === "webhookUrl") current.webhookUrl = val;
  }
  if (current.key && current.platform) {
    configs[current.key] = { platform: current.platform, enabled: current.enabled ?? true, token: current.token, webhookUrl: current.webhookUrl };
  }
  return configs;
}

export type MessageHandler = (msg: ChannelMessage) => Promise<string>;

export class ChannelRouter {
  private adapters = new Map<string, ChannelAdapter>();
  private handler: MessageHandler | null = null;
  readonly configs: Record<string, ChannelConfig>;

  constructor(configPath?: string) {
    const path = configPath ?? join(homedir(), ".8gent", "channels.yaml");
    this.configs = existsSync(path) ? parseSimpleYaml(readFileSync(path, "utf-8")) : {};
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
    adapter.onMessage((msg) => this.route(msg));
  }

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  async route(message: ChannelMessage): Promise<void> {
    if (!this.handler) return;
    const response = await this.handler(message);
    const adapter = this.adapters.get(message.platform);
    if (!adapter) return;

    const reply: ChannelMessage = {
      id: crypto.randomUUID(),
      channelId: message.channelId,
      platform: message.platform,
      senderId: "eight",
      content: response,
      replyTo: message.id,
      timestamp: Date.now(),
    };
    await adapter.send(reply);
  }

  async broadcast(content: string, platforms: string[]): Promise<void> {
    const sends = platforms.map(async (p) => {
      const adapter = this.adapters.get(p);
      if (!adapter) return;
      const msg: ChannelMessage = {
        id: crypto.randomUUID(),
        channelId: "broadcast",
        platform: adapter.name,
        senderId: "eight",
        content,
        timestamp: Date.now(),
      };
      await adapter.send(msg);
    });
    await Promise.allSettled(sends);
  }

  getAdapter(platform: string): ChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  get platforms(): string[] {
    return Array.from(this.adapters.keys());
  }
}
