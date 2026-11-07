import { describe, expect, test } from "bun:test";
import {
	type ErrorKind,
	classifyError,
	describeProviderFailure,
	errorLines,
	errorNotice,
	guardNotice,
	guardNoticeOf,
	noticeLines,
	noticeText,
	retryNotice,
	retryRow,
} from "./error-row";

describe("classifyError: kind, cause and next step from the text", () => {
	const cases: Array<[string, ErrorKind, string, RegExp]> = [
		[
			"provider timeout after 60s",
			"timeout",
			"provider timeout after 60s",
			/send again|\/provider/,
		],
		[
			"ETIMEDOUT connecting to 127.0.0.1:11434",
			"timeout",
			"ETIMEDOUT connecting to 127.0.0.1:11434",
			/\/provider/,
		],
		[
			"connect ECONNREFUSED 127.0.0.1:11434",
			"network",
			"connect ECONNREFUSED 127.0.0.1:11434",
			/model server|connection/,
		],
		["fetch failed", "network", "fetch failed", /connection/],
		["429 Too Many Requests", "limit", "429 Too Many Requests", /wait|\/provider/],
		[
			"Provider returned error: rate limit exceeded",
			"limit",
			"Provider returned error: rate limit exceeded",
			/wait/,
		],
		[
			"401 Unauthorized: invalid api key",
			"provider",
			"401 Unauthorized: invalid api key",
			/\/provider/,
		],
		["503 Service Unavailable", "provider", "503 Service Unavailable", /send again|\/provider/],
		[
			"[BLOCKED] Not run: refused by policy, nothing was checked or changed.",
			"policy",
			"Not run: refused by policy, nothing was checked or changed.",
			/request/,
		],
		[
			'Error running tool "read_file": ENOENT no such file',
			"tool",
			"ENOENT no such file",
			/tool row/,
		],
		["Stopped by user", "stopped", "Stopped by user", /send again/],
		["something odd happened", "error", "something odd happened", /^$/],
	];
	for (const [text, kind, cause, next] of cases) {
		test(JSON.stringify(text.slice(0, 40)), () => {
			const r = classifyError(text);
			expect(r.kind).toBe(kind);
			expect(r.cause).toBe(cause);
			expect(r.next ?? "").toMatch(next);
		});
	}

	test("[Error] and Error: prefixes are dropped", () => {
		expect(classifyError("[Error] fetch failed").cause).toBe("fetch failed");
		expect(classifyError("Error: fetch failed").cause).toBe("fetch failed");
	});

	test("all providers exhausted names the first provider, its cause and how many were tried", () => {
		const r = classifyError(
			"All providers exhausted (2 attempted):\n  - ollama/qwen: connect ECONNREFUSED 127.0.0.1:11434\n  - openrouter/x: 429",
		);
		expect(r.kind).toBe("provider");
		expect(r.cause).toBe("ollama: not running (ECONNREFUSED) (2 tried)");
		expect(r.next).toBe("start the model server, or /provider to pick another");
	});

	test("the phone case: one hosted provider answering 401 names the key command, not a bare count", () => {
		const r = classifyError(
			"All providers exhausted (1 attempted):\n  - minimax/MiniMax-M3.1-Flash: HTTP 401: invalid api key (2049)",
		);
		expect(r.cause).toBe("minimax: HTTP 401, key rejected");
		expect(r.next).toBe(
			"8gent keys set minimax with a new key, then restart 8gent; or /provider to pick another",
		);
		const text = errorLines(r, 60).join("\n");
		expect(text).not.toContain("all providers failed");
	});

	test("an empty exhausted list keeps the plain count", () => {
		const r = classifyError(
			"All providers exhausted (0 attempted):\n  (no provider errors recorded)",
		);
		expect(r.cause).toBe("all providers failed (0 tried)");
	});

	test("a model id with a colon still parses", () => {
		const r = classifyError(
			"All providers exhausted (1 attempted):\n  - openrouter-free/vendor/m:free: HTTP 429: Too Many Requests",
		);
		expect(r.cause).toBe("openrouter-free: HTTP 429, rate limited");
	});

	test("a pinned provider's error is described the same way", () => {
		const r = classifyError(
			"minimax/MiniMax-M3 failed: x\nThe provider was chosen explicitly, so no other provider was tried.",
		);
		expect(r.kind).toBe("provider");
		expect(r.cause).toBe("minimax: x");
	});
});

describe("describeProviderFailure: one cause, one next step", () => {
	const cases: Array<[string, string, string, RegExp]> = [
		[
			"minimax",
			"No API key for minimax, so nothing was sent to api.minimax.io. Add your key with `8gent keys set minimax` (MINIMAX_API_KEY), or edit",
			"minimax: no API key (MINIMAX_API_KEY)",
			/^8gent keys set minimax, then restart 8gent/,
		],
		[
			"openrouter-free",
			"HTTP 403: Forbidden",
			"openrouter-free: HTTP 403, key rejected",
			/8gent keys set openrouter /,
		],
		["groq", "HTTP 402: Payment Required", "groq: HTTP 402, no credit left", /top up/],
		[
			"openrouter",
			"HTTP 404: model x does not exist",
			"openrouter: HTTP 404, model not found",
			/^\/model /,
		],
		["openrouter", "HTTP 503: upstream", "openrouter: HTTP 503, provider-side error", /send again/],
		["minimax", "fetch failed", "minimax: network error (fetch failed)", /online/],
		[
			"llama-server",
			"connect ECONNREFUSED 127.0.0.1:8080",
			"llama-server: not running (ECONNREFUSED)",
			/start the model server/,
		],
		["minimax", "Turn timed out after 120s", "minimax: timed out", /send again/],
	];
	for (const [provider, error, cause, next] of cases) {
		test(cause, () => {
			const d = describeProviderFailure(provider, error);
			expect(d.cause).toBe(cause);
			expect(d.next).toMatch(next);
		});
	}

	test("a key echoed in an error body is never shown", () => {
		const d = describeProviderFailure("x", "weird reply sk-abcdefghijklmnop1234 Bearer abc.def");
		expect(d.cause).not.toContain("sk-abcdefghijklmnop1234");
		expect(d.cause).not.toContain("abc.def");
		expect(d.cause).toContain("[hidden]");
	});
});

describe("classifyError fallthrough", () => {
	test("the cause is one line, at most 70 characters", () => {
		const r = classifyError(`boom ${"x".repeat(300)}\nsecond line`);
		expect(r.cause.length).toBeLessThanOrEqual(70);
		expect(r.cause.includes("\n")).toBe(false);
		expect(r.cause.endsWith("…")).toBe(true);
	});

	test("empty text is a plain error, never a crash", () => {
		expect(classifyError("").kind).toBe("error");
		expect(classifyError("   ").cause).toBe("unknown error");
	});
});

describe("retryRow: a retry that is happening", () => {
	test("rate limit with the count and the wait", () => {
		const r = retryRow({
			kind: "rate_limit",
			provider: "openrouter",
			model: "m",
			attempt: 2,
			max: 4,
			cause: "429",
			delayMs: 4000,
		});
		expect(r).toMatchObject({ kind: "limit", retry: { n: 2, of: 4 } });
		expect(r.cause).toContain("429");
		expect(r.next).toBe("waiting 4s");
	});
	test("a failover names where it goes next", () => {
		const r = retryRow({
			kind: "failover",
			provider: "ollama",
			model: "qwen",
			attempt: 1,
			max: 1,
			cause: "connect ECONNREFUSED",
			next: "openrouter/auto",
		});
		expect(r.kind).toBe("network");
		expect(r.next).toBe("fallback openrouter/auto");
		// A hop down the chain is not a counted retry.
		expect(r.retry).toBeUndefined();
	});
	test("a transient error retried on the same backend", () => {
		const r = retryRow({
			kind: "transient",
			provider: "p",
			model: "m",
			attempt: 1,
			max: 1,
			cause: "503 Service Unavailable",
		});
		expect(r.kind).toBe("provider");
		expect(r.retry).toEqual({ n: 1, of: 1 });
	});
});

describe("errorLines at 100 and 52 columns", () => {
	const row = {
		kind: "timeout" as const,
		cause: "provider timeout after 60s",
		retry: { n: 2, of: 3 },
		next: "fallback ollama/qwen",
	};
	test("wide: kind, cause and the count on one line, next on the second", () => {
		const l = errorLines(row, 100);
		expect(l[0]).toBe("✗ timeout  provider timeout after 60s  retry 2 of 3");
		expect(l[1]).toBe("  next: fallback ollama/qwen");
		expect(l).toHaveLength(2);
	});
	test("narrow: the cause alone leads, then the count, then the next step, each on its own line", () => {
		const l = errorLines(row, 40);
		expect(l).toEqual([
			"✗ timeout: provider timeout after 60s",
			"  retry 2/3",
			"  next: fallback ollama/qwen",
		]);
	});
	test("nothing wider than the column, whatever the text", () => {
		const long = {
			kind: "provider" as const,
			cause: "y".repeat(200),
			retry: { n: 3, of: 3 },
			next: "z".repeat(200),
		};
		for (const w of [30, 40, 52, 100])
			for (const line of errorLines(long, w)) expect(line.length).toBeLessThanOrEqual(w);
	});
	test("no retry and no next is a single line", () => {
		expect(errorLines({ kind: "error", cause: "something odd" }, 80)).toEqual([
			"✗ error  something odd",
		]);
	});
	test("only plain characters: no escapes or control codes in the text", () => {
		const l = errorLines({ kind: "tool", cause: "bad \u001b[31mred\u001b[0m\u0007 text" }, 80);
		expect(l[0]).toBe("✗ tool  bad red text");
	});
});

describe("guardNotice: one line when a retry or a loop guard fires", () => {
	test("loop warning names the tool and the count", () => {
		expect(guardNotice({ kind: "loop_warning", tool: "edit_file", count: 3 }, 100)).toBe(
			"! loop: edit_file failed 3 times, trying another way",
		);
	});
	test("nudge for a repeat of calls that all worked", () => {
		expect(
			guardNotice(
				{ kind: "loop_nudge", reason: "I repeated a read_file call that had already worked." },
				100,
			),
		).toBe("! loop: I repeated a read_file call that had already worked");
	});
	test("circuit breaker says the turn stopped, in the agent's own words", () => {
		expect(
			guardNotice(
				{
					kind: "circuit_breaker",
					reason:
						"I made the same run_command call 4 times in a row, so I stopped to avoid a loop.",
				},
				100,
			),
		).toBe(
			"! stopped: I made the same run_command call 4 times in a row, so I stopped to avoid a loop",
		);
	});
	test("fits the column, with an ellipsis", () => {
		for (const w of [30, 40, 52]) {
			const n = guardNotice({ kind: "circuit_breaker", reason: "word ".repeat(40) }, w);
			expect(n.length).toBeLessThanOrEqual(w);
			expect(n.endsWith("…")).toBe(true);
		}
	});
	test("a missing field never prints undefined", () => {
		expect(guardNotice({ kind: "loop_warning" }, 80)).not.toContain("undefined");
		expect(guardNotice({ kind: "circuit_breaker" }, 80)).toBe("! stopped: loop guard");
	});
});

describe("retryNotice: a retry is one line", () => {
	const base = {
		provider: "openrouter",
		model: "m",
		attempt: 2,
		max: 3,
		cause: "429 Too Many Requests",
	};
	test("a rate limit says the count, the cause and the wait", () => {
		expect(retryNotice({ ...base, kind: "rate_limit", delayMs: 4000 }, 100)).toBe(
			"! retry 2/3 in 4s: 429 Too Many Requests",
		);
	});
	test("a transient retry has no wait unless given", () => {
		expect(retryNotice({ ...base, kind: "transient" }, 100)).toBe(
			"! retry 2/3: 429 Too Many Requests",
		);
	});
	test("a failover names the model that failed and where it goes", () => {
		expect(
			retryNotice(
				{
					...base,
					kind: "failover",
					cause: "connect ECONNREFUSED 127.0.0.1:11434",
					next: "openrouter/auto",
				},
				100,
			),
		).toBe("! m failed (connect ECONNREFUSED 127.0.0.1:11434), trying openrouter/auto");
	});
	test("fits 40 and 52 columns", () => {
		for (const w of [40, 52]) {
			const n = retryNotice(
				{ ...base, kind: "rate_limit", cause: "x".repeat(200), delayMs: 2000 },
				w,
			);
			expect(n.length).toBeLessThanOrEqual(w);
		}
	});
});

describe("notices carried on a chat message", () => {
	test("an error notice renders as the error row and reads as plain text", () => {
		const n = errorNotice("provider timeout after 60s", 3);
		expect(n.tone).toBe("error");
		expect(noticeLines(n, 100)).toEqual([
			"✗ timeout  provider timeout after 60s  retry 3 of 3",
			"  next: send again, or /provider to switch",
		]);
		expect(noticeText(n)).toBe(noticeLines(n, 80).join("\n"));
	});
	test("with no retries made, no count is shown", () => {
		expect(noticeLines(errorNotice("fetch failed", 0), 100)[0]).toBe("✗ network  fetch failed");
	});
	test("a guard notice is one warn line", () => {
		const n = guardNoticeOf({
			kind: "circuit_breaker",
			reason: "I made the same read_file call 3 times in a row, so I stopped to avoid a loop.",
		});
		expect(n.tone).toBe("warn");
		expect(noticeLines(n, 100)).toEqual([
			"! stopped: I made the same read_file call 3 times in a row, so I stopped to avoid a loop",
		]);
	});
});
