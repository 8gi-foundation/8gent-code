/**
 * 8gent Code - Telegram Turth Surface
 *
 * Wires the interactive Turth permission prompt to Telegram as an
 * inline-keyboard prompt. Validates the clicking user against the
 * configured TELEGRAM_CHAT_ID equivalent to prevent third-party hijack.
 *
 * Security posture (8SO):
 *   - Only the user whose id matches TELEGRAM_AUTHORIZED_USER_ID (or
 *     the configured chatId for private chats) can answer a prompt.
 *   - Unmatched users are ignored silently; their interaction is logged.
 *   - Each prompt has a unique token; replayed callbacks are rejected.
 */

import {
  registerPromptSurface,
  type ApprovalScope,
  type TurthRequest,
} from "../permissions/turth.js";
import type { TelegramBot } from "./index";

const SCOPE_BUTTONS: Array<[string, ApprovalScope]> = [
  ["Once", "once"],
  ["Session", "session"],
  ["Project", "project"],
  ["Always", "always"],
  ["Deny", "deny"],
];

interface Pending {
  token: string;
  resolve: (scope: ApprovalScope) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const PENDING = new Map<string, Pending>();
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function newToken(): string {
  return `turth_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isAuthorisedUser(userId: number, bot: TelegramBot): boolean {
  const authorised = process.env.TELEGRAM_AUTHORIZED_USER_ID;
  if (authorised) {
    return String(userId) === authorised;
  }
  // Fallback: in a private 1:1 chat the chatId equals the user id, so
  // use chatId as the authorised identity.
  return String(userId) === bot.getChatId();
}

/**
 * Attach Telegram as the active Turth prompt surface.
 * Returns an unsubscribe function that removes the interceptor and
 * clears the surface registration.
 */
export function attachTelegramTurthSurface(bot: TelegramBot): () => void {
  const unregisterInterceptor = bot.registerCallbackInterceptor(
    async ({ data, userId }) => {
      // Only intercept callbacks we own.
      if (!data.startsWith("turth_")) return false;

      // "<token>|<scope>": scope is the second half after the last "|".
      const pipeIdx = data.lastIndexOf("|");
      if (pipeIdx < 0) return false;
      const token = data.slice(0, pipeIdx);
      const scopeRaw = data.slice(pipeIdx + 1);

      const pending = PENDING.get(token);
      if (!pending) return true; // We own the prefix; swallow even if expired.

      if (!isAuthorisedUser(userId, bot)) {
        console.warn(
          `[turth] Rejected callback from unauthorised user ${userId} for token ${token}`
        );
        return true;
      }

      const scope = SCOPE_BUTTONS.find(([, s]) => s === scopeRaw)?.[1];
      if (!scope) return true;

      clearTimeout(pending.timeout);
      PENDING.delete(token);
      pending.resolve(scope);
      return true;
    }
  );

  registerPromptSurface(async (req: TurthRequest) => {
    const token = newToken();

    const body =
      `Permission requested\n\n` +
      `${req.summary}\n` +
      (req.detail ? `\n${req.detail}\n` : "") +
      `\nCapability: \`${req.capability}\``;

    const buttons = [
      SCOPE_BUTTONS.slice(0, 2).map(([label, scope]) => ({
        text: label,
        callback_data: `${token}|${scope}`,
      })),
      SCOPE_BUTTONS.slice(2, 4).map(([label, scope]) => ({
        text: label,
        callback_data: `${token}|${scope}`,
      })),
      [
        {
          text: SCOPE_BUTTONS[4][0],
          callback_data: `${token}|${SCOPE_BUTTONS[4][1]}`,
        },
      ],
    ];

    await bot.sendMessage(body, {
      parseMode: "Markdown",
      replyMarkup: { inline_keyboard: buttons },
    });

    return new Promise<ApprovalScope>((resolve) => {
      const timeout = setTimeout(() => {
        PENDING.delete(token);
        // Fail closed on timeout: deny.
        resolve("deny");
      }, PROMPT_TIMEOUT_MS);
      PENDING.set(token, { token, resolve, timeout });
    });
  });

  return () => {
    unregisterInterceptor();
    registerPromptSurface(null);
    for (const p of PENDING.values()) {
      clearTimeout(p.timeout);
      p.resolve("deny");
    }
    PENDING.clear();
  };
}
