/**
 * /llama and /models: drive a local llama-server router from inside a session (#4206).
 *
 * Pure over an injected router so every branch is tested with a stubbed fetch.
 * `/models use <id>` only returns the id to switch to; the caller swaps the
 * model on the live tab session, so the conversation carries on. A model the
 * server cannot load is reported and the session stays on its current model.
 */

import type {
	LlamaRouter,
	RouterModel,
} from "../../../../packages/local-model-server/llama-router.js";
import { isRouterMode } from "../../../../packages/local-model-server/llama-router.js";

export interface LlamaCommandContext {
	router: LlamaRouter;
	currentModel: string;
	currentProvider: string;
}

export interface LlamaCommandResult {
	message: string;
	/** Set only when the caller should switch the session to this model id. */
	useModel?: string;
}

/**
 * Switch the live tab session to `model` without a rebuild: set the model on it and record
 * it as built for that model, so the rebuild effect's canReuseTabAgent check passes and the
 * message history stays. Returns false when there is no live session to keep.
 */
export function switchModelInPlace(
	live: { setModel(model: string): void } | null,
	built: WeakMap<object, { model: string; runtime: string }>,
	model: string,
	runtime: string,
): boolean {
	if (!live) return false;
	live.setModel(model);
	built.set(live, { model, runtime });
	return true;
}

export const LLAMA_USAGE =
	"Usage: /llama [status|load <id>|unload <id>]  |  /models [list|use <id>]";

function modelLine(m: RouterModel, current: string): string {
	const mark = m.id === current ? "*" : " ";
	const state = m.status ? `  ${m.status}${m.failed ? " (last load failed)" : ""}` : "";
	return `  ${mark} ${m.id}${state}`;
}

async function listOrReason(router: LlamaRouter): Promise<RouterModel[] | string> {
	try {
		return await router.models();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function status(ctx: LlamaCommandContext): Promise<string> {
	const { router, currentModel } = ctx;
	const health = await router.health();
	const lines = [
		`llama-server ${router.baseUrl}`,
		`  health: ${health.ok ? "ok" : `down (${health.detail})`}`,
	];
	if (health.httpStatus === 0) return lines.join("\n");
	const list = await listOrReason(router);
	if (typeof list === "string") return [...lines, `  models: ${list}`].join("\n");
	const routed = isRouterMode(list);
	lines.push(`  mode: ${routed ? "router (switch per request)" : "single model"}`);
	const loaded = list.filter((m) => m.status === "loaded").map((m) => m.id);
	if (routed) lines.push(`  loaded: ${loaded.length ? loaded.join(", ") : "none"}`);
	lines.push(`  current: ${currentModel || "none"}`);
	// GET /props and /metrics need ?model= in router mode: ask about a loaded model only,
	// the current one first, so a status check never starts a load.
	const target = routed ? (loaded.includes(currentModel) ? currentModel : loaded[0]) : undefined;
	if (routed && !target) return [...lines, "  props, metrics: no loaded model to ask"].join("\n");
	const [props, metrics] = await Promise.all([router.props(target), router.metrics(target)]);
	if (typeof props === "string") lines.push(`  props: ${props}`);
	else {
		if (props.nCtx !== undefined) lines.push(`  context: ${props.nCtx} tokens`);
		if (props.sleeping !== undefined) lines.push(`  sleeping: ${props.sleeping ? "yes" : "no"}`);
	}
	if (typeof metrics === "string") lines.push(`  metrics: ${metrics}`);
	else {
		const n = (k: string) => metrics[`llamacpp:${k}`];
		const fmt = (v: number | undefined, unit = "") =>
			v === undefined ? "-" : `${Math.round(v * 10) / 10}${unit}`;
		lines.push(
			`  metrics: prompt ${fmt(n("prompt_tokens_seconds"), " tok/s")}, generate ${fmt(n("predicted_tokens_seconds"), " tok/s")}, ` +
				`busy ${fmt(n("requests_processing"))}, queued ${fmt(n("requests_deferred"))}, peak context ${fmt(n("n_tokens_max"))}`,
		);
	}
	lines.push("  GPU memory: llama-server does not report it; run nvidia-smi");
	return lines.join("\n");
}

async function listModels(ctx: LlamaCommandContext): Promise<string> {
	const list = await listOrReason(ctx.router);
	if (typeof list === "string") return `Models: ${list}`;
	if (list.length === 0) return `No models listed by ${ctx.router.baseUrl}.`;
	return [
		`Models on ${ctx.router.baseUrl} (* = current):`,
		...list.map((m) => modelLine(m, ctx.currentModel)),
	].join("\n");
}

async function use(ctx: LlamaCommandContext, id: string | undefined): Promise<LlamaCommandResult> {
	if (!id) return { message: "Usage: /models use <id>  (see /models for ids)" };
	if (ctx.currentProvider !== "llama-server")
		return {
			message: `/models use switches llama-server models. Run /provider llama-server first (now: ${ctx.currentProvider}).`,
		};
	const list = await listOrReason(ctx.router);
	if (typeof list === "string")
		return { message: `Cannot switch to ${id}: ${list}. Still on ${ctx.currentModel}.` };
	const found = list.find((m) => m.id === id);
	if (!found)
		return {
			message: `${id} is not served by ${ctx.router.baseUrl}. Still on ${ctx.currentModel}. Ids: ${list.map((m) => m.id).join(", ") || "none"}`,
		};
	if (isRouterMode(list) && found.status !== "loaded") {
		const r = await ctx.router.load(id);
		if (!r.ok)
			return {
				message: `llama-server could not load ${id}: ${r.detail}. Still on ${ctx.currentModel}.`,
			};
	}
	return { message: `Model switched to ${id}.`, useModel: id };
}

async function change(
	ctx: LlamaCommandContext,
	action: "load" | "unload",
	id: string | undefined,
): Promise<string> {
	if (!id) return `Usage: /llama ${action} <id>`;
	const r = await ctx.router[action](id);
	return r.ok
		? `${action === "load" ? "Loaded" : "Unloaded"} ${id}.`
		: `llama-server could not ${action} ${id}: ${r.detail}`;
}

export async function runLlamaCommand(
	command: "llama" | "models",
	args: string[],
	ctx: LlamaCommandContext,
): Promise<LlamaCommandResult> {
	const sub = (args[0] ?? "").toLowerCase();
	if (command === "models") {
		if (sub === "" || sub === "list") return { message: await listModels(ctx) };
		if (sub === "use") return use(ctx, args[1]);
		return { message: LLAMA_USAGE };
	}
	if (sub === "" || sub === "status") return { message: await status(ctx) };
	if (sub === "load" || sub === "unload") return { message: await change(ctx, sub, args[1]) };
	return { message: LLAMA_USAGE };
}
