/**
 * Telegram bot token slot adapter. B-2 only reserves the slot; the actual
 * BotFather token is set by B-7. The slot is a placeholder file at
 * <rootDir>/.8gent/tenants/<handle>/telegram-bot-token.placeholder containing
 * a one-line marker. The directory is gitignored at the project level.
 *
 * The slot deliberately lives outside the repo's secrets vault: the real token
 * goes onto the Hetzner box per Wave 4 PRD §B-7. This file is just a tracking
 * record so B-7 knows which tenants have an outstanding bot to mint.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Adapter, Ctx, PlanStep } from "./types.ts";

function slotPath(rootDir: string, handle: string): string {
	return join(rootDir, ".8gent", "tenants", handle, "telegram-bot-token.placeholder");
}

export const secretsAdapter: Adapter = {
	name: "telegram-slot",
	async plan(handle, ctx): Promise<PlanStep> {
		const path = slotPath(ctx.rootDir, handle);
		if (existsSync(path)) {
			return {
				resource: `telegram:${handle}`,
				status: "exists",
				detail: `slot already reserved at ${rel(ctx.rootDir, path)}`,
			};
		}
		if (!ctx.apply) {
			return {
				resource: `telegram:${handle}`,
				status: "create",
				detail: `would reserve slot at ${rel(ctx.rootDir, path)}`,
			};
		}
		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(
				path,
				`# Telegram bot token slot for tenant "${handle}"\n# Reserved by Wave 4 B-2 at ${ctx.now().toISOString()}.\n# B-7 will replace this file with the BotFather token (kept off-box; secrets vault on the Hetzner host).\n`,
				"utf8",
			);
			return {
				resource: `telegram:${handle}`,
				status: "create",
				detail: `reserved slot at ${rel(ctx.rootDir, path)}`,
			};
		} catch (e) {
			return {
				resource: `telegram:${handle}`,
				status: "error",
				detail: "secrets step failed",
				error: (e as Error).message,
			};
		}
	},
};

function rel(root: string, p: string): string {
	return p.startsWith(root) ? p.slice(root.length).replace(/^\//, "") : p;
}
