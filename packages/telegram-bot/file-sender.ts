/**
 * @8gent/telegram-bot - File Sender
 *
 * Wraps Telegram sendDocument / sendPhoto with sensible defaults:
 * - Reads from disk path or accepts in-memory Buffer
 * - Picks photo vs document by extension
 * - Enforces 50 MB Telegram cap (10 MB safe limit for photos)
 * - Inline preview-friendly captions with mobile formatter
 */

import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { TaskAttachment } from "./task-runner";

const TELEGRAM_API = "https://api.telegram.org/bot";

const PHOTO_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export interface FileSenderConfig {
	token: string;
	chatId: string;
}

export class FileSender {
	private token: string;
	private chatId: string;

	constructor(config: FileSenderConfig) {
		this.token = config.token;
		this.chatId = config.chatId;
	}

	/** Send a queued attachment (used by TaskRunner). */
	async send(attachment: TaskAttachment): Promise<void> {
		const buffer = await this.resolveBuffer(attachment);
		if (!buffer) {
			throw new Error(`file-sender: attachment ${attachment.filename} has no content`);
		}
		const kind = attachment.kind ?? this.detectKind(attachment.filename);
		if (kind === "photo" && buffer.byteLength > MAX_PHOTO_BYTES) {
			// Fall through to document if too large for photo.
			await this.sendDocument(buffer, attachment.filename, attachment.caption);
			return;
		}
		if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
			throw new Error(
				`file-sender: ${attachment.filename} is ${buffer.byteLength} bytes (max ${MAX_DOCUMENT_BYTES})`,
			);
		}
		if (kind === "photo") {
			await this.sendPhoto(buffer, attachment.filename, attachment.caption);
		} else {
			await this.sendDocument(buffer, attachment.filename, attachment.caption);
		}
	}

	/** Send arbitrary text content as a code-file document. */
	async sendCodeFile(filename: string, content: string, caption?: string): Promise<void> {
		const buffer = Buffer.from(content, "utf-8");
		await this.sendDocument(buffer, filename, caption);
	}

	/** Send a Buffer or file-on-disk as a photo. */
	async sendPhoto(input: Buffer | string, filename?: string, caption?: string): Promise<void> {
		const { buffer, name } = await this.resolveInput(input, filename ?? "photo.png");
		const form = new FormData();
		form.append("chat_id", this.chatId);
		form.append("photo", new Blob([new Uint8Array(buffer)]), name);
		if (caption) {
			form.append("caption", caption.slice(0, 1024));
			form.append("parse_mode", "Markdown");
		}
		await this.post("sendPhoto", form);
	}

	/** Send a Buffer or file-on-disk as a document. */
	async sendDocument(input: Buffer | string, filename?: string, caption?: string): Promise<void> {
		const { buffer, name } = await this.resolveInput(input, filename ?? "file.bin");
		const form = new FormData();
		form.append("chat_id", this.chatId);
		form.append("document", new Blob([new Uint8Array(buffer)]), name);
		if (caption) {
			form.append("caption", caption.slice(0, 1024));
			form.append("parse_mode", "Markdown");
		}
		await this.post("sendDocument", form);
	}

	private async post(method: string, body: FormData): Promise<unknown> {
		const url = `${TELEGRAM_API}${this.token}/${method}`;
		const res = await fetch(url, { method: "POST", body });
		const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
		if (!json.ok) {
			throw new Error(`Telegram ${method}: ${json.description ?? "unknown error"}`);
		}
		return json.result;
	}

	private async resolveBuffer(attachment: TaskAttachment): Promise<Buffer | null> {
		if (attachment.buffer) return attachment.buffer;
		if (attachment.path) {
			if (!existsSync(attachment.path)) return null;
			return await Bun.file(attachment.path)
				.bytes()
				.then((b) => Buffer.from(b));
		}
		return null;
	}

	private async resolveInput(
		input: Buffer | string,
		fallback: string,
	): Promise<{ buffer: Buffer; name: string }> {
		if (typeof input === "string") {
			const stat = statSync(input);
			if (!stat.isFile()) throw new Error(`file-sender: ${input} is not a file`);
			const bytes = await Bun.file(input).bytes();
			return { buffer: Buffer.from(bytes), name: basename(input) };
		}
		return { buffer: input, name: fallback };
	}

	private detectKind(filename: string): "photo" | "document" {
		const ext = (filename.split(".").pop() ?? "").toLowerCase();
		return PHOTO_EXT.has(ext) ? "photo" : "document";
	}
}
