/**
 * One session's loop through Pi Durable (MIT, earendil-works/pi), over SQLite under ~/.8gent.
 * Behind EIGHT_DURABLE_RUN=1 for now. `openRun` can be called from any process: the same run id
 * finds the same conversation, and `resume()` continues whatever the last process left unfinished.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	Harness,
	type ModelRef,
	type ToolRegistration,
	createRegistry,
	defineExtension,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

export const EXTENSION = "eight-run";

export interface OpenRunOptions {
	storage: SqliteStorage;
	models: Models;
	model: ModelRef;
	tools: ToolRegistration[];
}

export interface Run {
	harness: Harness;
	root: Conversation;
	/** Submit once per requestId; a second call (any process) returns the same submission. Resolves with the answer entry id. */
	ask(content: string, requestId: string): Promise<number>;
	close(): Promise<void>;
}

export function durableRunEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_DURABLE_RUN === "1";
}

export async function openRun(opts: OpenRunOptions): Promise<Run> {
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	const extension = defineExtension({ name: EXTENSION, tools: opts.tools });
	registry.install(extension);
	const harness = await Harness.open(opts.storage, { models: opts.models, registry }, context);
	const root = await harness.root(context, {
		agent: { model: opts.model, extensions: [extension] },
	});
	harness.resume(); // continue any run the last process left unfinished
	return {
		harness,
		root,
		async ask(content, requestId) {
			const submission = await root.submit({ type: "input", content, requestId }, context);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") {
				throw new Error(`run did not finish: ${settled.status}`);
			}
			return settled.answer as number;
		},
		close: () => harness.close(context),
	};
}
