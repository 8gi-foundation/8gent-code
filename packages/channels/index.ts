/** @8gent/channels - Multi-platform messaging abstraction */

export type {
  Platform,
  ChannelMessage,
  Attachment,
  ChannelAdapter,
  ChannelConfig,
} from "./types";

export { ChannelRouter } from "./router";
export type { MessageHandler } from "./router";

export { TelegramChannelAdapter } from "./adapters/telegram";
