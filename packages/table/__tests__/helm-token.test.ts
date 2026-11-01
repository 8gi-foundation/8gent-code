import { describe, expect, test } from "bun:test";
import { newToken, parseApproval, parseReply } from "../helm-bridge";

describe("helm token", () => {
	test("at least 128 bits: 26 base32 chars", () => {
		expect(newToken()).toMatch(/^[A-Z2-7]{26}$/);
	});
	test("1000 draws are unique", () => {
		const s = new Set<string>();
		for (let i = 0; i < 1000; i++) s.add(newToken());
		expect(s.size).toBe(1000);
	});
	test("round-trips through approve and reply parsers", () => {
		const t = newToken();
		expect(parseApproval(`/approve ${t}`)).toBe(t);
		expect(parseReply(`/reply ${t} yes`)).toEqual({ token: t, text: "yes" });
	});
	test("short legacy tokens still parse", () => {
		expect(parseApproval("/approve ab12cd")).toBe("AB12CD");
	});
});
