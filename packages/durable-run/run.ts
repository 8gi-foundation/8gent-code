/**
 * One session's loop over SQLite under ~/.8gent, in-repo. Behind EIGHT_DURABLE_RUN=1. The
 * transcript is append-only: entry `seq` is written with INSERT OR IGNORE, so when two processes
 * race for the next entry one lands and the other re-reads. Any process can `openRun` the same file
 * and `ask` continues where the last one stopped; the next step comes from the transcript alone.
 * Outside effects are guarded by the ledger in tools.ts.
 */
import { Database } from "bun:sqlite";
import type { Message, Provider, ToolCall } from "./scripted.js";
import { preparePrivateFile } from "./storage.js";
import type { ToolRegistration } from "./tools.js";

export { durableRunEnabled } from "./flag.js";

/** The one conversation of a run; effect keys are `<this>:<call id>`. */
export const CONVERSATION_ID = 1;

export interface OpenRunOptions {
	/** The run's SQLite file (shared with the effect ledger). */
	file: string;
	provider: Provider;
	tools: ToolRegistration[];
	/** Fires before and after every step: the kill test's cut points. */ onSql?: (
		label: string,
	) => void;
}

type Entry = { seq: number } & (
	| { type: "input"; requestId: string; content: string }
	| { type: "assistant"; text?: string; toolCalls?: ToolCall[] }
	| { type: "toolResult"; callId: string; text: string; isError?: boolean }
	| { type: "answer"; requestId: string; text: string }
);
type Body = Entry extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

export interface Run {
	/** Submit once per requestId; a second call (any process) continues it. Resolves with the answer entry id. */
	ask(content: string, requestId: string): Promise<number>;
	close(): Promise<void>;
}

const toMessages = (es: Entry[]): Message[] =>
	es.flatMap((e): Message[] =>
		e.type === "input"
			? [{ role: "user", content: e.content }]
			: e.type === "assistant"
				? [{ role: "assistant", text: e.text, toolCalls: e.toolCalls }]
				: e.type === "toolResult"
					? [{ role: "toolResult", callId: e.callId, text: e.text, isError: e.isError }]
					: [],
	);

export async function openRun(opts: OpenRunOptions): Promise<Run> {
	preparePrivateFile(opts.file);
	const db = new Database(opts.file);
	const q = <T>(label: string, f: () => T): T => {
		opts.onSql?.(`run:${label}:before`);
		const out = f();
		const after = <V>(v: V): V => {
			opts.onSql?.(`run:${label}:after`);
			return v;
		};
		return out instanceof Promise ? (out.then(after) as T) : after(out);
	};
	q("pragma", () =>
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"),
	);
	q("create", () =>
		db.exec(
			"CREATE TABLE IF NOT EXISTS eight_entries (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)",
		),
	);

	const entries = (): Entry[] =>
		q("read", () =>
			(
				db.prepare("SELECT seq, body FROM eight_entries ORDER BY seq").all() as {
					seq: number;
					body: string;
				}[]
			).map((r) => ({ ...JSON.parse(r.body), seq: r.seq }) as Entry),
		);
	const append = (seq: number, body: Body): unknown =>
		q("append", () =>
			db
				.prepare("INSERT OR IGNORE INTO eight_entries (seq, body) VALUES (?, ?)")
				.run(seq, JSON.stringify(body)),
		);

	async function step(es: Entry[], requestId: string): Promise<void> {
		opts.onSql?.("run:step");
		const next = es.length + 1;
		const lastAssistant = es.findLastIndex((e) => e.type === "assistant");
		const a = es[lastAssistant];
		if (a?.type === "assistant") {
			const pending = (a.toolCalls ?? []).find(
				(c) => !es.some((e) => e.type === "toolResult" && e.callId === c.id),
			);
			if (pending) {
				const tool = opts.tools.find((t) => t.name === pending.name);
				const r = await q("tool", async () =>
					tool
						? tool.execute(pending.args, { conversationId: CONVERSATION_ID, callId: pending.id })
						: {
								output: [{ type: "text" as const, text: `no tool named ${pending.name}` }],
								isError: true,
							},
				);
				append(next, {
					type: "toolResult",
					callId: pending.id,
					text: r.output.map((o) => o.text).join(""),
					...(r.isError ? { isError: true } : {}),
				});
				return;
			}
			if (lastAssistant === es.length - 1) {
				append(next, { type: "answer", requestId, text: a.text ?? "" });
				return;
			}
		}
		const reply = await q("model", () => opts.provider.next(toMessages(es)));
		append(next, { type: "assistant", ...reply });
	}

	return {
		async ask(content, requestId) {
			opts.onSql?.("run:ask:before");
			for (;;) {
				const es = entries();
				const answer = es.find((e) => e.type === "answer" && e.requestId === requestId);
				if (answer) {
					opts.onSql?.("run:ask:after");
					return answer.seq;
				}
				if (!es.some((e) => e.type === "input" && e.requestId === requestId))
					append(es.length + 1, { type: "input", requestId, content });
				else await step(es, requestId);
			}
		},
		async close() {
			q("close", () => db.close());
		},
	};
}
