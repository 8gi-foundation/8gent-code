/**
 * Settling an aborted or failed local turn (#2922 chat manners).
 *
 * Pressing ESC while the model is replying used to produce two bubbles: the
 * TUI's "Generation interrupted." and then the agent's catch block returning
 * "The local model turn could not complete: The operation was aborted" as an
 * assistant turn. A user abort is not an error. These tests pin the contract
 * the catch block now runs on: a user abort ends quietly with nothing in the
 * history, and every real failure keeps its friendly turn.
 */

import { describe, expect, it } from "bun:test";
import {
	USER_ABORT,
	describeLocalTurnFailure,
	isAbortError,
	isUserAbort,
	settleFailedLocalTurn,
} from "./turn-abort";

const ENDPOINT = "http://localhost:11434/v1";

/** The error fetch raises once its signal is aborted. */
function abortError(): Error {
	const err = new Error("The operation was aborted");
	err.name = "AbortError";
	return err;
}

describe("isUserAbort", () => {
	it("recognises Agent.abort() with the default reason on the signal", () => {
		const controller = new AbortController();
		controller.abort(USER_ABORT);
		expect(isUserAbort(controller.signal)).toBe(true);
		expect(isUserAbort(controller.signal, abortError())).toBe(true);
	});

	it("does not treat a timeout-driven abort as the user's", () => {
		// withTurnTimeout aborts the shared controller with no reason.
		const controller = new AbortController();
		controller.abort();
		expect(isUserAbort(controller.signal, abortError())).toBe(false);
	});

	it("does not treat the circuit breaker or watchdog as the user's", () => {
		for (const reason of ["circuit-breaker", "session-watchdog"]) {
			const controller = new AbortController();
			controller.abort(reason);
			expect(isUserAbort(controller.signal, abortError())).toBe(false);
		}
	});

	it("is false for a live signal and a plain error", () => {
		const controller = new AbortController();
		expect(isUserAbort(controller.signal, new Error("fetch failed"))).toBe(false);
	});
});

describe("isAbortError", () => {
	it("matches by name, not by class", () => {
		expect(isAbortError(abortError())).toBe(true);
		expect(isAbortError({ name: "AbortError" })).toBe(true);
		expect(isAbortError(new Error("nope"))).toBe(false);
		expect(isAbortError(null)).toBe(false);
		expect(isAbortError("AbortError")).toBe(false);
	});
});

describe("settleFailedLocalTurn", () => {
	it("ends a user abort quietly: empty turn, nothing recorded", () => {
		const controller = new AbortController();
		controller.abort(USER_ABORT);
		const history: Array<{ role: string; content: string }> = [
			{ role: "user", content: "Write a haiku about terminals" },
		];
		const reply = settleFailedLocalTurn({
			err: abortError(),
			signal: controller.signal,
			endpoint: ENDPOINT,
			history,
		});
		expect(reply).toBe("");
		expect(history).toHaveLength(1);
		expect(history[0].role).toBe("user");
	});

	it("keeps the reachability turn for a provider that is down", () => {
		const controller = new AbortController();
		const history: Array<{ role: string; content: string }> = [];
		const reply = settleFailedLocalTurn({
			err: new Error("fetch failed"),
			signal: controller.signal,
			endpoint: ENDPOINT,
			history,
		});
		expect(reply).toContain(`The local model endpoint (${ENDPOINT}) is not reachable.`);
		expect(reply).toContain("(fetch failed)");
		expect(history).toEqual([{ role: "assistant", content: reply }]);
	});

	it("keeps the generic turn for any other error, including a breaker abort", () => {
		const controller = new AbortController();
		controller.abort("circuit-breaker");
		const history: Array<{ role: string; content: string }> = [];
		const reply = settleFailedLocalTurn({
			err: abortError(),
			signal: controller.signal,
			endpoint: ENDPOINT,
			history,
		});
		expect(reply).toBe("The local model turn could not complete: The operation was aborted");
		expect(history).toEqual([{ role: "assistant", content: reply }]);
	});

	it("stringifies non-Error throwables", () => {
		expect(describeLocalTurnFailure("boom", ENDPOINT)).toBe(
			"The local model turn could not complete: boom",
		);
	});
});
