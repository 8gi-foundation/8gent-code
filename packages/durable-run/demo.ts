/**
 * The scripted run behind the kill test (#4883): search, write a file, send through a stubbed
 * Telegram send. The model is Pi's scripted provider, decided from the transcript alone, so any
 * process that opens the same run gets the same next step. `8gent durable-run <dir>` runs it.
 *
 * Kill injection: with `killAt = n`, the process SIGKILLs itself at its nth tick. A tick is every
 * SQLite write Pi makes, every effect boundary, and the gate call: the places a run can be cut.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { registerToolManifest } from "../permissions/capability-manifest.js";
import { evaluateToolCall } from "../permissions/policy-engine.js";
import { EffectLedger } from "./ledger.js";
import { openRun } from "./run.js";
import { openRunStorage } from "./storage.js";
import { type Gate, type Replay, durableTool } from "./tools.js";

/** How the Telegram send declares itself: the three rows of the replay rule. */
export type SendVariant = "key" | "nokey" | "undeclared";

export interface DemoOptions {
	dir: string;
	variant?: SendVariant;
	/** Kill this process at its nth tick (1-based). */
	killAt?: number;
	/** Which client is running, written into the effect log. */
	client?: string;
	/** Append `<n> <label>` for every tick, so a test can find a position by name. */
	tickLog?: string;
}

export interface DemoResult {
	answerEntry: number;
	ticks: number;
}

const FILE = "notes.txt";
const CONTENT = "release notes: durable runs\n";

function append(file: string, row: Record<string, unknown>): void {
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function wrapExecutor<T extends SqliteExecutor>(inner: T, tick: (l: string) => void): T {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, target);
			if (prop === "exec" || prop === "run") {
				return async (...args: unknown[]) => {
					const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
					tick(`sql:${String(prop)}`);
					return out;
				};
			}
			return typeof value === "function" ? value.bind(target) : Reflect.get(target, prop, receiver);
		},
	});
}

function killableDatabase(inner: SqliteDatabase, tick: (l: string) => void): SqliteDatabase {
	const wrapped = wrapExecutor(inner, tick);
	return Object.assign(Object.create(wrapped), {
		transaction: <R>(cb: (t: SqliteExecutor) => Promise<R>) =>
			inner.transaction((t) => cb(wrapExecutor(t, tick))),
	}) as SqliteDatabase;
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
	const { dir } = opts;
	const variant = opts.variant ?? "key";
	const client = opts.client ?? "tui";
	fs.mkdirSync(path.join(dir, "out"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(dir, "corpus.txt"),
		"durable runs resume after a crash\nunrelated line\n",
		{ mode: 0o600 },
	);
	const effects = path.join(dir, "effects.log");
	const gateLog = path.join(dir, "gate.log");

	let ticks = 0;
	const tick = (label: string) => {
		ticks++;
		if (opts.tickLog) fs.appendFileSync(opts.tickLog, `${ticks} ${label}\n`);
		if (opts.killAt !== undefined && ticks === opts.killAt) process.kill(process.pid, "SIGKILL");
	};

	// Capability manifests: the permission layer denies a tool with none.
	registerToolManifest({ tool: "search_notes", fs: { read: [path.join(dir, "corpus.txt")] } });
	registerToolManifest({ tool: "telegram_send", network: { hosts: ["api.telegram.org"] } });

	// The existing tool gate, asked before EVERY execution, replays included.
	const gate: Gate = async (tool, args) => {
		tick(`gate:${tool}`);
		append(gateLog, { client, tool });
		const a = args as { path?: string };
		const request =
			tool === "write_file"
				? { kind: "fs_write" as const, path: path.join(dir, "out", String(a.path)) }
				: tool === "search_notes"
					? { kind: "fs_read" as const, path: path.join(dir, "corpus.txt") }
					: { kind: "network" as const, url: "https://api.telegram.org/bot/sendMessage" };
		const d = evaluateToolCall(tool, request, { workingDirectory: dir });
		return d.allowed ? { run: true } : { run: false, reason: d.reason };
	};

	const dbFile = path.join(dir, "run.sqlite");
	const ledger = new EffectLedger(dbFile);
	const deps = { gate, ledger, checkpoint: tick };

	const tools = [
		durableTool(
			{
				name: "search_notes",
				description: "Search the notes corpus for a word",
				parameters: Type.Object({ query: Type.String() }),
				replay: "safe",
				run: async (a) =>
					fs
						.readFileSync(path.join(dir, "corpus.txt"), "utf8")
						.split("\n")
						.filter((l) => l.includes(a.query))
						.join("\n"),
			},
			deps,
		),
		durableTool(
			{
				name: "write_file",
				description: "Write a file under the run folder",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				replay: "once",
				idempotentByKey: true, // a hash check: identical content is left alone
				run: async (a) => {
					const target = path.join(dir, "out", a.path);
					tick("write:before");
					if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === a.content)
						return "unchanged";
					fs.writeFileSync(`${target}.tmp`, a.content, { mode: 0o600 });
					fs.renameSync(`${target}.tmp`, target);
					append(effects, { ev: "write", path: a.path, client });
					tick("write:after");
					return "written";
				},
			},
			deps,
		),
		durableTool(
			{
				name: "telegram_send",
				description: "Send a message through Telegram",
				parameters: Type.Object({ text: Type.String() }),
				...(variant === "undeclared" ? {} : { replay: "once" as Replay }),
				...(variant === "key" ? { idempotentByKey: true } : {}),
				run: async (a, { key }) => {
					// The stub is a receiver that honours the idempotency key, as a send layer with a
					// sent-log would: a repeated key is not delivered twice.
					tick("send:before");
					append(effects, { ev: "attempt", client });
					const sent = path.join(dir, "sent.jsonl");
					const seen =
						fs.existsSync(sent) && fs.readFileSync(sent, "utf8").includes(JSON.stringify(key));
					if (!seen || variant !== "key")
						append(effects, { ev: "send", key, client, text: a.text });
					if (!seen) fs.appendFileSync(sent, `${JSON.stringify(key)}\n`, { mode: 0o600 });
					tick("send:after");
					return "sent";
				},
			},
			deps,
		),
	];

	// Decided from the transcript alone, so a second process continues the same script.
	const faux = fauxProvider();
	faux.setResponses(
		Array.from({ length: 12 }, () => (context) => {
			const results = context.messages.filter((m) => m.role === "toolResult").length;
			if (results === 0)
				return fauxAssistantMessage(
					[fauxToolCall("search_notes", { query: "durable" }, { id: "call-search" })],
					{ stopReason: "toolUse" },
				);
			if (results === 1)
				return fauxAssistantMessage(
					[fauxToolCall("write_file", { path: FILE, content: CONTENT }, { id: "call-write" })],
					{ stopReason: "toolUse" },
				);
			if (results === 2)
				return fauxAssistantMessage(
					[fauxToolCall("telegram_send", { text: "notes written" }, { id: "call-send" })],
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage([fauxText("done")]);
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);

	const storage = await openRunStorage(dbFile, (db) => killableDatabase(db, tick));
	const run = await openRun({
		storage,
		models,
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
		tools,
	});
	try {
		const answerEntry = await run.ask("write the release notes and tell the team", "job-1");
		return { answerEntry, ticks };
	} finally {
		await run.close();
		ledger.close();
	}
}
