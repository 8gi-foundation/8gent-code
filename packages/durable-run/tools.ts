/**
 * Tools for a durable run. Every tool declares what a restart may do with it (#4883):
 *
 *   safe  reads only; rerun freely after a cut.
 *   once  an outside effect. A finished call is never run again. A call cut off mid-effect runs
 *         again only when the tool says `idempotentByKey` (the target honours the key we hand it,
 *         as a write_file hash check does); otherwise it is NOT rerun and shows as unresolved.
 *   ask   anything else, and any tool with no declaration. Never rerun; unresolved for a person.
 *
 * Mapping to Pi Durable's per-tool rule (`replay: "safe" | "unsafe"`): safe and once are "safe" to
 * Pi, because the ledger below makes the rerun harmless; ask is "unsafe", so Pi gives the model an
 * `interrupted` result instead of running it.
 *
 * The gate runs INSIDE execute, so it stands in front of every execution, replays included. A Pi
 * beforeTool hook would not: it runs once, before the intent is recorded.
 */
import type { TSchema } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { EffectLedger } from "./ledger.js";

export type Replay = "safe" | "once" | "ask";

export interface GateAnswer {
	run: boolean;
	reason?: string;
}
/** The existing permission layer, asked before every execution. */
export type Gate = (tool: string, args: unknown) => Promise<GateAnswer>;

export interface DurableToolSpec<P extends TSchema> {
	name: string;
	description: string;
	parameters: P;
	/** Undeclared counts as "ask". */
	replay?: Replay;
	/** once only: the target dedupes on `key`, so running the effect again is harmless. */
	idempotentByKey?: boolean;
	/** `key` is stable across restarts: pass it to the target as its idempotency key. */
	run(args: Static<P>, ctx: { key: string }): Promise<string>;
}

export interface DurableDeps {
	gate: Gate;
	ledger: EffectLedger;
	/** Test seam: called at each effect boundary, so a kill test can stop the process there. */
	checkpoint?: (point: string) => void;
}

const text = (t: string, isError = false) => ({
	output: [{ type: "text" as const, text: t }],
	...(isError ? { isError: true } : {}),
});

export function durableTool<P extends TSchema>(
	spec: DurableToolSpec<P>,
	deps: DurableDeps,
): ToolRegistration<P> {
	const replay: Replay = spec.replay ?? "ask";
	return defineTool({
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		replay: replay === "ask" ? "unsafe" : "safe",
		execute: async (args, api) => {
			const verdict = await deps.gate(spec.name, args);
			if (!verdict.run)
				return text(
					`blocked by the permission layer: ${verdict.reason ?? "no reason given"}`,
					true,
				);
			const key = `${api.conversationId}:${api.callId}`;
			if (replay === "safe") return text(await spec.run(args, { key }));

			const prior = deps.ledger.get(key);
			if (prior?.status === "done") return text(prior.result ?? "");
			if (prior?.status === "started" && !(replay === "once" && spec.idempotentByKey)) {
				return text(
					`${spec.name} was cut off mid-effect and may or may not have happened; it was not run again`,
					true,
				);
			}
			deps.ledger.start(key, spec.name);
			deps.checkpoint?.(`${spec.name}:after-intent`);
			const result = await spec.run(args, { key });
			deps.checkpoint?.(`${spec.name}:after-effect`);
			deps.ledger.done(key, result);
			deps.checkpoint?.(`${spec.name}:after-done`);
			return text(result);
		},
	});
}
