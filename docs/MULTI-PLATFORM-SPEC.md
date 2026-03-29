# Multi-Platform Messaging Spec

> Issue #944 - Unified channel abstraction for Discord, Slack, WhatsApp

## Problem

Eight communicates only through the TUI and Telegram bot. Each new platform requires a bespoke integration. We need a channel abstraction layer so adding a new platform is just writing an adapter, not rewiring the agent.

## Constraint

Each platform has different message limits, formatting (Markdown vs mrkdwn vs plain text), media handling, and rate limits. The abstraction must normalize these without losing platform-specific features. NemoClaw policy must govern per-channel permissions.

## Not doing

- Voice/video channels (text messaging only for now)
- Platform-specific rich components (buttons, modals - LATER)
- Multi-user threading within a channel (single conversation per channel)
- Building actual platform bots (this spec is the abstraction layer; individual bot packages exist separately)

## Success metric

A new platform adapter can be implemented in under 100 lines by conforming to the channel interface. Existing Telegram bot refactored to use this abstraction with no behavior change.

---

## 1. Unified Message Format

All platforms normalize to/from this internal format:

```typescript
interface ChannelMessage {
  id: string;
  channelId: string;
  platform: "telegram" | "discord" | "slack" | "whatsapp" | "tui";
  author: { id: string; name: string; isBot: boolean };
  content: string;           // plain text or markdown
  attachments?: Attachment[];
  replyTo?: string;          // message id being replied to
  timestamp: number;
}

interface Attachment {
  type: "image" | "file" | "code";
  url?: string;
  data?: Buffer;
  filename?: string;
  mimeType?: string;
}
```

---

## 2. Channel Adapter Interface

```typescript
interface ChannelAdapter {
  platform: string;
  connect(config: PlatformConfig): Promise<void>;
  disconnect(): Promise<void>;

  send(channelId: string, message: ChannelMessage): Promise<string>;  // returns message id
  onMessage(handler: (msg: ChannelMessage) => void): void;

  // Platform-specific formatting
  formatMarkdown(md: string): string;   // convert standard MD to platform format
  maxMessageLength: number;             // platform limit (Telegram 4096, Discord 2000, Slack 40000)
  splitMessage(content: string): string[]; // auto-split long messages
}
```

---

## 3. Channel Router

Routes incoming messages to the agent and outgoing responses to the correct adapter:

```typescript
interface ChannelRouter {
  adapters: Map<string, ChannelAdapter>;
  register(adapter: ChannelAdapter): void;
  route(message: ChannelMessage): Promise<void>;  // dispatches to agent
  reply(channelId: string, response: string): Promise<void>;  // sends via correct adapter
}
```

---

## 4. Per-Channel NemoClaw Policy

Each channel gets a policy scope in `~/.8gent/channel-policies.yaml`:

```yaml
channels:
  telegram-personal:
    permissions: [fs:read, fs:write, exec:shell, memory:write]
  discord-public:
    permissions: [memory:read]  # read-only in public channels
  slack-work:
    permissions: [fs:read, exec:shell]
```

The policy engine receives `channelId` as context and applies the matching rule set.

---

## 5. Platform Formatting

| Platform | Format | Max Length | Code Blocks | Media |
|----------|--------|-----------|-------------|-------|
| Telegram | Markdown V2 | 4096 | ``` supported | photos, files |
| Discord | Discord Markdown | 2000 | ``` supported | embeds, files |
| Slack | mrkdwn | 40000 | ``` supported | files via API |
| WhatsApp | Limited MD | 65536 | no code blocks | images, docs |

Each adapter's `formatMarkdown()` handles the conversion.

---

## 6. Files to Create/Modify

**Create:**
- `packages/channels/types.ts` - ChannelMessage, ChannelAdapter, ChannelRouter interfaces (~60 lines)
- `packages/channels/router.ts` - message routing, adapter registry (~80 lines)
- `packages/channels/adapters/telegram.ts` - refactored from existing telegram-bot (~120 lines)
- `packages/channels/adapters/discord.ts` - Discord adapter stub (~80 lines)
- `packages/channels/adapters/slack.ts` - Slack adapter stub (~80 lines)

**Modify:**
- `packages/telegram-bot/` - refactor to use channel adapter interface (~40 lines changed)
- `packages/permissions/policy-engine.ts` - add channel context to policy evaluation (~15 lines)
- `packages/eight/agent.ts` - accept messages from channel router (~20 lines)

## 7. Estimated Effort

5 new files (~420 lines), 3 modified files (~75 lines). Total: ~495 lines across 8 files.

Architecture reference: Matrix protocol's room abstraction. Also inspired by Botpress's channel connectors and LangChain's callback system for multi-output routing.
