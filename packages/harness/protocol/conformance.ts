/**
 * Conformance rubric for HarnessAdapter. Runs against any adapter given a
 * fixture of three turns it knows how to produce. No test runner inside:
 * it returns one result per check, so a test file, a CLI or a CI step can
 * each decide what to do with them. Check ids match the rubric table in
 * docs/specs/HARNESS-PROTOCOL.md.
 */

import {
	HARNESS_PROTOCOL_VERSION,
	type HarnessAdapter,
	HarnessError,
	type HarnessErrorCode,
	type HarnessEvent,
	type HarnessTurn,
	type StartOptions,
	type TurnEnded,
	type TurnInput,
} from "./types";

export interface ConformanceFixture {
	/** A turn that completes and whose whole output is exactly `expect`. */
	echo: { input: TurnInput; expect: string };
	/** A turn that writes some text, then keeps running until cancelled (5s or more). */
	long: TurnInput;
	/** A turn that fails. */
	fail: TurnInput;
	/** Options for every session the rubric starts. */
	start?: StartOptions;
	/** Longest any single wait may take, in ms. Default 5000. */
	deadlineMs?: number;
}

export type CheckOutcome = "pass" | "fail" | "skip";

export interface CheckResult {
	id: string;
	title: string;
	outcome: CheckOutcome;
	detail?: string;
}

class CheckFailed extends Error {}
class Skip extends Error {}

function must(cond: unknown, detail: string): asserts cond {
	if (!cond) throw new CheckFailed(detail);
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new CheckFailed(`${what} took longer than ${ms}ms`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function collect(turn: HarnessTurn): Promise<HarnessEvent[]> {
	const out: HarnessEvent[] = [];
	for await (const e of turn.events()) out.push(e);
	return out;
}

function sendThrows(fn: () => unknown, code: HarnessErrorCode): void {
	try {
		fn();
	} catch (err) {
		must(err instanceof HarnessError, `threw ${String(err)}, not a HarnessError`);
		must(err.code === code, `threw code "${err.code}", expected "${code}"`);
		return;
	}
	throw new CheckFailed(`did not throw; expected HarnessError "${code}"`);
}

/** Resolves once the turn has emitted an event that matches, or rejects at the deadline. */
async function waitFor(
	turn: HarnessTurn,
	match: (e: HarnessEvent) => boolean,
	ms: number,
	what: string,
): Promise<HarnessEvent> {
	const seek = (async () => {
		for await (const e of turn.events()) if (match(e)) return e;
		throw new CheckFailed(`${what}: turn ended without it`);
	})();
	return within(seek, ms, what);
}

const CAPABILITY_KEYS: Record<string, "string" | "boolean" | "number"> = {
	protocol: "string",
	harness: "string",
	streaming: "boolean",
	sessions: "boolean",
	cancel: "boolean",
	maxConcurrentTurns: "number",
	local: "boolean",
};

export async function runConformance(
	adapter: HarnessAdapter,
	fixture: ConformanceFixture,
): Promise<CheckResult[]> {
	const ms = fixture.deadlineMs ?? 5000;
	const results: CheckResult[] = [];
	const check = async (id: string, title: string, body: () => unknown | Promise<unknown>) => {
		try {
			await body();
			results.push({ id, title, outcome: "pass" });
		} catch (err) {
			if (err instanceof Skip) results.push({ id, title, outcome: "skip", detail: err.message });
			else
				results.push({
					id,
					title,
					outcome: "fail",
					detail: err instanceof Error ? err.message : String(err),
				});
		}
	};

	const caps = adapter.capabilities();
	const started = new Set<string>();
	const begin = async () => {
		const s = await within(adapter.start(fixture.start), ms, "start()");
		started.add(s.id);
		return s;
	};

	await check("H-01", "capabilities are complete, typed and stable", () => {
		for (const [key, type] of Object.entries(CAPABILITY_KEYS)) {
			const actual = typeof (caps as unknown as Record<string, unknown>)[key];
			must(actual === type, `${key} is a ${actual}, not a ${type}`);
		}
		must(
			caps.protocol === HARNESS_PROTOCOL_VERSION,
			`protocol "${caps.protocol}" is not ${HARNESS_PROTOCOL_VERSION}`,
		);
		must(
			caps.harness === adapter.id,
			`harness "${caps.harness}" is not the adapter id "${adapter.id}"`,
		);
		must(caps.maxConcurrentTurns >= 1, "maxConcurrentTurns is below 1");
		must(
			JSON.stringify(adapter.capabilities()) === JSON.stringify(caps),
			"a second call answered differently",
		);
	});

	await check("H-02", "start gives distinct sessions named for the harness", async () => {
		const a = await begin();
		const b = await begin();
		must(a.id && b.id && a.id !== b.id, "session ids are empty or equal");
		must(a.harness === adapter.id, `session.harness "${a.harness}" is not "${adapter.id}"`);
		must(typeof a.cwd === "string" && a.cwd.length > 0, "session.cwd is empty");
	});

	await check("H-03", "send refuses empty input before a turn begins", async () => {
		const s = await begin();
		sendThrows(() => adapter.send(s.id, { text: "   " }), "empty_input");
	});

	await check("H-04", "send to an unknown session is session_not_found", () => {
		sendThrows(() => adapter.send("no-such-session", fixture.echo.input), "session_not_found");
	});

	// One completed turn feeds H-05 to H-10.
	let echoEvents: HarnessEvent[] = [];
	let echoDone: TurnEnded | undefined;
	let echoTurn: HarnessTurn | undefined;
	let echoSession = "";
	const echoReady = (async () => {
		const s = await begin();
		echoSession = s.id;
		echoTurn = adapter.send(s.id, fixture.echo.input);
		echoEvents = await within(collect(echoTurn), ms, "echo turn");
		echoDone = await within(echoTurn.done, ms, "echo turn done");
	})().catch((err) => err as Error);
	const needEcho = async () => {
		const err = await echoReady;
		if (err) throw new CheckFailed(`echo turn did not run: ${err.message}`);
	};

	await check("H-05", "turn.started comes first, seq 0, naming session and harness", async () => {
		await needEcho();
		const first = echoEvents[0];
		must(first?.type === "turn.started", `first event is ${first?.type}`);
		must(first.seq === 0, `first seq is ${first.seq}`);
		must(
			first.type === "turn.started" && first.sessionId === echoSession,
			"sessionId does not match",
		);
		must(first.type === "turn.started" && first.harness === adapter.id, "harness does not match");
	});

	await check("H-06", "seq is gapless and every event carries the turn id", async () => {
		await needEcho();
		echoEvents.forEach((e, i) => {
			must(e.seq === i, `event ${i} has seq ${e.seq}`);
			must(e.turnId === echoTurn?.id, `event ${i} has turnId ${e.turnId}`);
		});
	});

	await check("H-07", "exactly one turn.ended, and it is last", async () => {
		await needEcho();
		const ends = echoEvents.filter((e) => e.type === "turn.ended");
		must(ends.length === 1, `${ends.length} turn.ended events`);
		must(echoEvents.at(-1)?.type === "turn.ended", "turn.ended is not the last event");
	});

	await check("H-08", "done resolves to the same turn.ended the stream carried", async () => {
		await needEcho();
		must(
			JSON.stringify(echoDone) === JSON.stringify(echoEvents.at(-1)),
			"done and the stream disagree",
		);
	});

	await check("H-09", "a completed turn's output is its deltas joined", async () => {
		await needEcho();
		const joined = echoEvents.map((e) => (e.type === "text.delta" ? e.text : "")).join("");
		must(echoDone?.status === "completed", `status is ${echoDone?.status}`);
		must(echoDone.output === joined, "output differs from the joined deltas");
		must(echoDone.output === fixture.echo.expect, `output ${JSON.stringify(echoDone.output)}`);
		must(echoDone.error === undefined, "a completed turn carries an error");
	});

	await check("H-10", "a reader who starts after the end still gets every event", async () => {
		await needEcho();
		const replay = await within(collect(echoTurn as HarnessTurn), ms, "replay");
		must(
			JSON.stringify(replay) === JSON.stringify(echoEvents),
			"replay differs from the live read",
		);
	});

	await check("H-11", "the session takes another turn after one ends", async () => {
		await needEcho();
		const again = adapter.send(echoSession, fixture.echo.input);
		const end = await within(again.done, ms, "second turn");
		must(end.status === "completed", `second turn ended ${end.status}`);
		must(again.id !== echoTurn?.id, "second turn reused the first turn's id");
	});

	await check("H-12", "a failing turn ends failed with an error", async () => {
		const s = await begin();
		const end = await within(adapter.send(s.id, fixture.fail).done, ms, "fail turn");
		must(end.status === "failed", `status is ${end.status}`);
		must(typeof end.error === "string" && end.error.trim().length > 0, "error is empty");
	});

	// The long turn feeds H-13 to H-17.
	const cancelable = caps.cancel;
	await check("H-13", "events stream while the turn is still running", async () => {
		if (!cancelable) throw new Skip("no cancel capability, so no long turn can be ended");
		const s = await begin();
		const turn = adapter.send(s.id, fixture.long);
		try {
			await waitFor(turn, (e) => e.type === "turn.started", ms, "turn.started");
			if (caps.streaming)
				await waitFor(turn, (e) => e.type === "text.delta", ms, "first text.delta");
			let ended = false;
			void turn.done.then(() => {
				ended = true;
			});
			await Promise.resolve();
			must(!ended, "the turn had already ended, so nothing streamed");
		} finally {
			await adapter.cancel(turn.id);
			await within(turn.done, ms, "cleanup cancel").catch(() => {});
		}
	});

	await check("H-14", "a busy session refuses a second turn", async () => {
		if (!cancelable) throw new Skip("no cancel capability");
		if (caps.maxConcurrentTurns !== 1) throw new Skip("adapter allows concurrent turns");
		const s = await begin();
		const turn = adapter.send(s.id, fixture.long);
		try {
			sendThrows(() => adapter.send(s.id, fixture.echo.input), "session_busy");
		} finally {
			await adapter.cancel(turn.id);
			await within(turn.done, ms, "cleanup cancel").catch(() => {});
		}
	});

	await check(
		"H-15",
		"cancel stops a running turn as cancelled, keeping partial output",
		async () => {
			if (!cancelable) throw new Skip("no cancel capability");
			const s = await begin();
			const turn = adapter.send(s.id, fixture.long);
			if (caps.streaming)
				await waitFor(turn, (e) => e.type === "text.delta", ms, "first text.delta");
			must((await adapter.cancel(turn.id)) === true, "cancel of a running turn returned false");
			const end = await within(turn.done, ms, "cancelled turn");
			must(end.status === "cancelled", `status is ${end.status}`);
			must(end.error === undefined, "a cancelled turn carries an error");
			const events = await within(collect(turn), ms, "cancelled replay");
			const joined = events.map((e) => (e.type === "text.delta" ? e.text : "")).join("");
			must(end.output === joined, "output differs from the joined deltas");
		},
	);

	await check("H-16", "cancel of a finished or unknown turn is false", async () => {
		if (!cancelable) throw new Skip("no cancel capability");
		await needEcho();
		must((await adapter.cancel(echoTurn?.id as string)) === false, "finished turn: true");
		must((await adapter.cancel("no-such-turn")) === false, "unknown turn: true");
	});

	await check("H-17", "stop ends a running turn and forgets the session", async () => {
		const s = await begin();
		if (cancelable) {
			const turn = adapter.send(s.id, fixture.long);
			await within(adapter.stop(s.id), ms, "stop()");
			const end = await within(turn.done, ms, "turn under stop");
			must(end.status === "cancelled", `turn under stop ended ${end.status}`);
		} else {
			await within(adapter.stop(s.id), ms, "stop()");
		}
		sendThrows(() => adapter.send(s.id, fixture.echo.input), "session_not_found");
		await within(adapter.stop(s.id), ms, "second stop()");
	});

	for (const id of started) await adapter.stop(id).catch(() => {});
	return results;
}

/** Failed checks, formatted one per line. Empty when the adapter conforms. */
export function failures(results: CheckResult[]): string[] {
	return results.filter((r) => r.outcome === "fail").map((r) => `${r.id} ${r.title}: ${r.detail}`);
}
