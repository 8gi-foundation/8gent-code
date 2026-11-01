import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySink, resetSinkToStdout, setSink } from "./emitter";
import type { LLMEvent } from "./events";
import {
	FLOW_SCHEMA_VERSION,
	flowFilePath,
	flowFromLlmEvent,
	flowNoteMessage,
	flowNoteNotification,
	flowNotePresence,
	flowNoteTurnAudio,
	installFlowTap,
	scanForDrift,
	uninstallFlowTap,
	validateFlowRecord,
	writeFlowRecord,
} from "./flow-stream";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "flow-telemetry-"));
	process.env.FLOW_TELEMETRY_DIR = dir;
});
afterEach(() => {
	delete process.env.FLOW_TELEMETRY_DIR;
	rmSync(dir, { recursive: true, force: true });
	uninstallFlowTap();
	resetSinkToStdout();
});

const validPresence = () => ({
	v: FLOW_SCHEMA_VERSION,
	kind: "presence",
	ts: "2026-08-11T10:00:00.000Z",
	channelId: "chan_1",
	agentId: "agent:8TO",
	state: "thinking",
});

describe("validateFlowRecord", () => {
	test("accepts a valid record of each kind", () => {
		const ts = "2026-08-11T10:00:00.000Z";
		const records = [
			{ v: 1, kind: "llm_latency", ts, provider: "ollama", model: "qwen3.6:27b", latencyMs: 106 },
			{ v: 1, kind: "turn_audio", ts, huddleId: "huddle_a", turnId: "turn_b", holder: "agent:8TO", durationMs: 21964 },
			validPresence(),
			{ v: 1, kind: "notification", ts, ntype: "task-complete", disposition: "delivered", channel: "telegram" },
			{ v: 1, kind: "message", ts, channelId: "chan_1", authorId: "human:james", authorKind: "human" },
		];
		for (const r of records) expect(validateFlowRecord(r).ok).toBe(true);
	});

	test("refuses unknown version", () => {
		const r = validateFlowRecord({ ...validPresence(), v: 2 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("version");
	});

	test("refuses unknown kind", () => {
		expect(validateFlowRecord({ ...validPresence(), kind: "affect" }).ok).toBe(false);
	});

	test("refuses unknown extra field (drift)", () => {
		const r = validateFlowRecord({ ...validPresence(), mood: "focused" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("unknown field mood");
	});

	test("refuses missing required field", () => {
		const { agentId: _dropped, ...rest } = validPresence();
		expect(validateFlowRecord(rest).ok).toBe(false);
	});

	test("refuses wrong type and non-finite numbers", () => {
		expect(validateFlowRecord({ ...validPresence(), channelId: 42 }).ok).toBe(false);
		const ts = "2026-08-11T10:00:00.000Z";
		expect(
			validateFlowRecord({ v: 1, kind: "llm_latency", ts, provider: "p", model: "m", latencyMs: Number.NaN }).ok,
		).toBe(false);
	});

	test("refuses out-of-enum values", () => {
		expect(validateFlowRecord({ ...validPresence(), state: "dreaming" }).ok).toBe(false);
	});

	test("refuses garbage ts", () => {
		expect(validateFlowRecord({ ...validPresence(), ts: "yesterdayish" }).ok).toBe(false);
	});
});

describe("writeFlowRecord", () => {
	test("writes valid records as JSONL to the flow dir", () => {
		expect(writeFlowRecord(validPresence())).toBe(true);
		expect(flowNoteTurnAudio("huddle_a", "turn_b", "agent:8EO", 21964)).toBe(true);
		expect(flowNotePresence("chan_1", "agent:8TO", "idle")).toBe(true);
		expect(flowNoteNotification("task-complete", "delivered", "telegram")).toBe(true);
		expect(flowNoteMessage("chan_1", "human:james")).toBe(true);
		const lines = readFileSync(flowFilePath(), "utf8").trim().split("\n");
		expect(lines.length).toBe(5);
		const msg = JSON.parse(lines[4] ?? "");
		expect(msg.authorKind).toBe("human"); // derived from the human: prefix
	});

	test("refuses a drifted record and writes nothing", () => {
		expect(writeFlowRecord({ ...validPresence(), heartRate: 60 })).toBe(false);
		expect(existsSync(flowFilePath())).toBe(false);
	});
});

describe("scanForDrift", () => {
	test("counts valid, invalid, and unparseable lines", async () => {
		writeFlowRecord(validPresence());
		writeFlowRecord({ ...validPresence(), state: "idle" });
		const file = Bun.file(flowFilePath());
		const drifted = `${JSON.stringify({ ...validPresence(), mood: "focused" })}\nnot json at all\n`;
		await Bun.write(flowFilePath(), (await file.text()) + drifted);
		const report = scanForDrift();
		expect(report.total).toBe(4);
		expect(report.valid).toBe(2);
		expect(report.invalid).toBe(2);
		expect(report.reasons.some((r) => r.includes("unknown field mood"))).toBe(true);
	});

	test("empty when file does not exist", () => {
		expect(scanForDrift(join(dir, "nope.jsonl")).total).toBe(0);
	});
});

describe("installFlowTap", () => {
	const llmEvent: LLMEvent = {
		kind: "llm",
		tenantId: "system",
		provider: "ollama",
		model: "qwen3.6:27b",
		promptTokens: 444,
		completionTokens: 44,
		latencyMs: 106,
		ts: "2026-08-11T10:00:00.000Z",
		channel: "delegation",
		sessionId: "s_1",
	};

	test("mirrors LLM events to the flow stream AND still feeds the original sink", () => {
		const memory = new MemorySink();
		setSink(memory);
		expect(installFlowTap()).toBe(true);
		expect(installFlowTap()).toBe(false); // idempotent
		const { getSink } = require("./emitter") as typeof import("./emitter");
		getSink().write(llmEvent);
		getSink().write({ kind: "vessel", tenantId: "system", endpoint: "/x", durationMs: 5 });
		expect(memory.events.length).toBe(2); // original sink untouched
		const lines = readFileSync(flowFilePath(), "utf8").trim().split("\n");
		expect(lines.length).toBe(1); // only the LLM event mirrored
		const rec = JSON.parse(lines[0] ?? "");
		expect(rec.kind).toBe("llm_latency");
		expect(rec.latencyMs).toBe(106);
		expect(rec.channel).toBe("delegation");
		expect(rec.promptTokens).toBeUndefined(); // tokens stay on the original event
	});

	test("uninstall restores the wrapped sink", () => {
		const memory = new MemorySink();
		setSink(memory);
		installFlowTap();
		uninstallFlowTap();
		const { getSink } = require("./emitter") as typeof import("./emitter");
		expect(getSink()).toBe(memory);
	});

	test("flowFromLlmEvent omits absent optionals instead of writing undefined", () => {
		const bare: LLMEvent = { kind: "llm", tenantId: "t", provider: "p", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 9 };
		const rec = flowFromLlmEvent(bare);
		expect("channel" in rec).toBe(false);
		expect(validateFlowRecord(rec).ok).toBe(true);
	});
});
