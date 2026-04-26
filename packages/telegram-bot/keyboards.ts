/**
 * @8gent/telegram-bot - Inline Keyboard Builders
 *
 * Pre-shaped inline keyboards for multi-step task flows.
 * All callback_data values are encoded with `safeData` to stay within
 * Telegram's 64-byte limit.
 */

import type { InlineKeyboardMarkup } from "./types";

export const CB_PREFIX = {
	taskContinue: "tc",
	taskCancel: "tx",
	taskRetry: "tr",
	taskNew: "tn",
	taskFiles: "tf",
	approve: "ok",
	deny: "no",
	confirm: "cf",
} as const;

/** Encode `prefix:payload` callback data, safely truncated to 64 bytes. */
export function safeData(prefix: string, payload = ""): string {
	const raw = payload ? `${prefix}:${payload}` : prefix;
	const buf = Buffer.from(raw, "utf-8");
	if (buf.length <= 64) return raw;
	const headRoom = 64 - prefix.length - 1; // room for `prefix:`
	if (headRoom <= 0) return prefix.slice(0, 64);
	return `${prefix}:${payload.slice(0, headRoom)}`;
}

/** Parse a callback_data string back into prefix + payload. */
export function parseCallbackData(data: string): { prefix: string; payload: string } {
	const idx = data.indexOf(":");
	if (idx === -1) return { prefix: data, payload: "" };
	return { prefix: data.slice(0, idx), payload: data.slice(idx + 1) };
}

/** Action row shown while a task is running. */
export function taskRunningKeyboard(taskId: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[{ text: "⏸ Cancel", callback_data: safeData(CB_PREFIX.taskCancel, taskId) }],
		],
	};
}

/** Action row shown after a task succeeded. */
export function taskCompleteKeyboard(taskId: string, hasFiles = false): InlineKeyboardMarkup {
	const row1 = [
		{ text: "▶ Continue", callback_data: safeData(CB_PREFIX.taskContinue, taskId) },
		{ text: "🆕 New task", callback_data: safeData(CB_PREFIX.taskNew, taskId) },
	];
	const rows = [row1];
	if (hasFiles) {
		rows.push([{ text: "📎 Resend files", callback_data: safeData(CB_PREFIX.taskFiles, taskId) }]);
	}
	return { inline_keyboard: rows };
}

/** Action row shown after a task failed. */
export function taskFailedKeyboard(taskId: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "↻ Retry", callback_data: safeData(CB_PREFIX.taskRetry, taskId) },
				{ text: "✕ Drop", callback_data: safeData(CB_PREFIX.taskCancel, taskId) },
			],
		],
	};
}

/** Approve / deny pair for in-flight permission prompts. */
export function approvalKeyboard(requestId: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "✓ Approve", callback_data: safeData(CB_PREFIX.approve, requestId) },
				{ text: "✕ Deny", callback_data: safeData(CB_PREFIX.deny, requestId) },
			],
		],
	};
}

/** Generic yes/no confirmation keyboard. */
export function confirmKeyboard(token: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{ text: "Yes", callback_data: safeData(CB_PREFIX.confirm, `y:${token}`) },
				{ text: "No", callback_data: safeData(CB_PREFIX.confirm, `n:${token}`) },
			],
		],
	};
}
