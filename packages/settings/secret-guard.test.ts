/** looksLikeSecret: keys are refused as names, real names are not (#5098). */
import { describe, expect, test } from "bun:test";
import { looksLikeSecret } from "./secret-guard.js";

describe("looksLikeSecret", () => {
	const keys = [
		"sk-ant-api03-AbCdEf1234567890AbCdEf1234567890",
		"sk-or-v1-0123456789abcdef0123456789abcdef",
		"sk-proj-AbCdEfGhIjKlMnOp1234",
		"ghp_AbCdEfGhIjKlMnOpQrSt1234567890",
		"gho_AbCdEfGhIjKlMnOpQrSt1234567890",
		"github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwx",
		"xai-AbCdEfGhIjKlMnOpQrStUvWx1234",
		"AIzaSyA-bcdefghijklmnopqrstuvwxyz12345",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz",
		"  sk-ant-api03-AbCdEf1234567890AbCdEf1234567890  ",
		"a8F3kd92LmQx71ZpWe05TnBv44Rc",
	];
	for (const k of keys) {
		test(`refuses a key: ${k.slice(0, 6)}...`, () => expect(looksLikeSecret(k)).toBe(true));
	}

	const names = [
		"James",
		"Eight",
		"Rishi",
		"Ada Lovelace",
		"Mary-Jane O'Neil",
		"Plato",
		"Orchestrator",
		"Zoë",
		"Ñuño",
		"山田太郎",
		"Eight 🙂",
		"🤖",
		"My research assistant for the whole house",
		"Supercalifragilisticexpialidocious",
		"",
		"   ",
	];
	for (const n of names) {
		test(`keeps a name: ${JSON.stringify(n)}`, () => expect(looksLikeSecret(n)).toBe(false));
	}

	test("non-strings are not secrets", () => {
		expect(looksLikeSecret(undefined)).toBe(false);
		expect(looksLikeSecret(null)).toBe(false);
		expect(looksLikeSecret(42)).toBe(false);
	});
});

describe("looksLikeSecret: hyphenated and numbered names are kept", () => {
	for (const n of [
		"Engineer2-Quality-Assurance-Bot",
		"Backend-Engineer-Agent-2024-v2",
		"my-tab-2026-10-25-release-notes",
		"Q3-2026-Planning-And-Roadmap-Tab",
		"sk-learning-bot",
		"Mary-Catherine O'Sullivan-Fitzgerald",
	]) {
		test(`keeps ${n}`, () => expect(looksLikeSecret(n)).toBe(false));
	}
	// Built from parts so the file holds no literal that secret scanning would flag.
	for (const k of [
		["xo", "xb-123456789012-abcdefghijklmn"].join(""),
		["sk_", "live_abcdefghijklmnopqrstuvwx"].join(""),
		["AKIA", "IOSFODNN7EXAMPLE"].join(""),
		"123e4567-e89b-12d3-a456-426614174000",
	]) {
		test(`refuses ${k.slice(0, 6)}...`, () => expect(looksLikeSecret(k)).toBe(true));
	}
});
