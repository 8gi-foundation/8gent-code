import { describe, expect, test } from "bun:test";
import {
	anonymize,
	anonymizeMessages,
	containsPii,
	deanonymize,
	registerOwnerIdentity,
	verifyClean,
} from "./pii-anonymizer";

// Officer-chat-shaped input: a system prompt + a conversation that mentions the
// owner, a third party, contact details, and financial identifiers.
const OFFICER_MESSAGES = [
	{ role: "system", content: "You are 8DO. Brief the board." },
	{
		role: "user",
		content:
			"James Spalding wants Sarah Connor emailed at sarah.connor@example.com " +
			"and called on +1 (415) 555-0182. Ship the invoice to 1600 Amphitheatre Parkway, Suite 200. " +
			"Card 4111 1111 1111 1111, IBAN GB29 NWBK 6016 1331 9268 19, SSN 123-45-6789.",
	},
];

describe("PII anonymizer - detection coverage", () => {
	test("masks email", () => {
		const r = anonymize("reach me at sarah.connor@example.com please");
		expect(r.text).not.toContain("sarah.connor@example.com");
		expect(r.text).toMatch(/\[EMAIL_\d+\]/);
	});

	test("masks phone", () => {
		const r = anonymize("call +1 (415) 555-0182 today");
		expect(r.text).not.toContain("555-0182");
		expect(r.text).toMatch(/\[PHONE_\d+\]/);
	});

	test("masks physical address", () => {
		const r = anonymize("ship to 1600 Amphitheatre Parkway, Suite 200 now");
		expect(r.text).not.toContain("Amphitheatre Parkway");
		expect(r.text).toMatch(/\[ADDRESS_\d+\]/);
	});

	test("masks credit card", () => {
		const r = anonymize("card 4111 1111 1111 1111 expires soon");
		expect(r.text).not.toContain("4111 1111 1111 1111");
		expect(r.text).toMatch(/\[CREDIT_CARD_\d+\]/);
	});

	test("masks IBAN", () => {
		const r = anonymize("IBAN GB29 NWBK 6016 1331 9268 19 on file");
		expect(r.text).not.toContain("GB29 NWBK");
		expect(r.text).toMatch(/\[IBAN_\d+\]/);
	});

	test("masks SSN", () => {
		const r = anonymize("ssn 123-45-6789 on record");
		expect(r.text).not.toContain("123-45-6789");
		expect(r.text).toMatch(/\[SSN_\d+\]/);
	});

	test("masks full names", () => {
		const r = anonymize("Sarah Connor approved the deal");
		expect(r.text).not.toContain("Sarah Connor");
		expect(r.text).toMatch(/\[PERSON_\d+\]/);
	});

	// The running user's own identity is covered in owner-identity.test.ts,
	// against an isolated HOME and git config.
});

describe("PII anonymizer - stability and reversibility", () => {
	test("same raw value gets the same pseudonym within a request", () => {
		const r = anonymize("Email sarah.connor@example.com twice: sarah.connor@example.com");
		const tokens = [...r.text.matchAll(/\[EMAIL_\d+\]/g)].map((m) => m[0]);
		expect(tokens.length).toBe(2);
		expect(tokens[0]).toBe(tokens[1]);
		expect(r.count).toBe(1);
	});

	test("de-anonymization restores the original text exactly", () => {
		const original =
			"James Spalding emailed sarah.connor@example.com about 1600 Amphitheatre Parkway, Suite 200.";
		const r = anonymize(original);
		expect(r.text).not.toBe(original);
		expect(deanonymize(r.text, r.map)).toBe(original);
	});

	test("shared map keeps pseudonyms consistent across messages", () => {
		const r = anonymizeMessages([
			{ role: "system", content: "Brief on sarah.connor@example.com." },
			{ role: "user", content: "Reply to sarah.connor@example.com." },
		]);
		const all = r.messages.map((m) => m.content).join(" ");
		const tokens = [...all.matchAll(/\[EMAIL_\d+\]/g)].map((m) => m[0]);
		expect(tokens.length).toBe(2);
		expect(tokens[0]).toBe(tokens[1]);
	});
});

describe("PII anonymizer - cloud-payload cleanliness (officer-chat shape)", () => {
	test("no email/phone/name/PII survives in the outbound messages", () => {
		const r = anonymizeMessages(OFFICER_MESSAGES);
		const outbound = r.messages.map((m) => m.content).join("\n");

		// Raw identifiers must be gone.
		expect(outbound).not.toContain("James Spalding");
		expect(outbound).not.toContain("Sarah Connor");
		expect(outbound).not.toContain("sarah.connor@example.com");
		expect(outbound).not.toContain("555-0182");
		expect(outbound).not.toContain("Amphitheatre Parkway");
		expect(outbound).not.toContain("4111 1111 1111 1111");
		expect(outbound).not.toContain("GB29 NWBK");
		expect(outbound).not.toContain("123-45-6789");

		// And the verifier agrees the payload is clean.
		expect(verifyClean(outbound)).toBe(true);
	});

	test("restoring the cloud response yields real values for the caller", () => {
		const r = anonymizeMessages(OFFICER_MESSAGES);
		// Simulate a cloud reply that echoes pseudonyms back.
		const personToken = r.messages[1].content.match(/\[PERSON_\d+\]/)?.[0];
		expect(personToken).toBeDefined();
		const cloudReply = `I have notified ${personToken} of the update.`;
		const restored = deanonymize(cloudReply, r.map);
		// The owner's real name comes back for the user, even though the cloud
		// only saw the pseudonym.
		expect(restored).toMatch(/James Spalding|Sarah Connor/);
	});
});

describe("PII anonymizer - judge shape", () => {
	test("judge-shaped prompt+response has no PII outbound", () => {
		const prompt = "User asked James Spalding to email sarah.connor@example.com.";
		const response = "Wrote a script that texts +1 (415) 555-0182 on completion.";
		const safePrompt = anonymize(prompt).text;
		const safeResponse = anonymize(response).text;
		expect(containsPii(safePrompt)).toBe(false);
		expect(containsPii(safeResponse)).toBe(false);
	});
});

describe("PII anonymizer - verifier / fail-closed signal", () => {
	test("verifyClean is false when raw PII is present", () => {
		expect(verifyClean("contact sarah.connor@example.com")).toBe(false);
	});

	test("verifyClean is true for benign code text", () => {
		expect(verifyClean("const total = a + b; return total;")).toBe(true);
	});

	test("registerOwnerIdentity folds in extra contacts at runtime", () => {
		registerOwnerIdentity(
			[{ value: "contact@8gent.app", type: "EMAIL" }],
			["Osboro"],
		);
		expect(containsPii("ping contact@8gent.app")).toBe(true);
		expect(anonymize("from Osboro here").text).not.toContain("Osboro");
	});
});

describe("PII anonymizer - empty / benign inputs", () => {
	test("empty string is a no-op", () => {
		const r = anonymize("");
		expect(r.text).toBe("");
		expect(r.count).toBe(0);
	});

	test("benign code is not mangled", () => {
		const code = "function add(a, b) { return a + b; }";
		const r = anonymize(code);
		expect(r.text).toBe(code);
	});
});
