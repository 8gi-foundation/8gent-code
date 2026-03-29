/** @8gent/channels - Unified multi-platform messaging types */

export type Platform = "telegram" | "discord" | "slack" | "whatsapp" | "tui";

export interface ChannelMessage {
  id: string;
  channelId: string;
  platform: Platform;
  senderId: string;
  content: string;
  attachments?: Attachment[];
  replyTo?: string;
  timestamp: number;
}

export interface Attachment {
  type: "image" | "file" | "code";
  url?: string;
  data?: Buffer;
  filename?: string;
  mimeType?: string;
}

export interface ChannelAdapter {
  readonly name: Platform;
  readonly maxMessageLength: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: ChannelMessage): Promise<string>; // returns message id
  onMessage(callback: (msg: ChannelMessage) => void): void;
}

export interface ChannelConfig {
  platform: Platform;
  enabled: boolean;
  token?: string;
  webhookUrl?: string;
  options?: Record<string, unknown>;
}
