import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../../goal/ledger";
import { hasClaimMarkers, processClaims, valuesEqual } from "../pipeline";

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-pipe-"));
	fs.writeFileSync(path.join(root, "three.txt"), "alpha\nbeta\ngamma\n");
	fs.writeFileSync(path.join(root, "five.txt"), "1\n2\n3\n4\n5\n");
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const opts = () => ({ roots: [root] });

describe("valuesEqual", () => {
	test("numeric equivalence across formats", () => {
		expect(valuesEqual("313", "313")).toBe(true);
		expect(valuesEqual("313", " 313 ")).toBe(true);
		expect(valuesEqual("313", "313.0")).toBe(true);
		expect(valuesEqual("313", "314")).toBe(false);
	});
	test("hashes compare exactly, not numerically", () => {
		expect(valuesEqual("abc123", "abc123")).toBe(true);
		expect(valuesEqual("abc123", "ABC123")).toBe(false);
	});
});

describe("processClaims - reference mode (the model never wrote the value)", () => {
	test("a pure reference is resolved and substituted with provenance", () => {
		const p = path.join(root, "three.txt");
		const out = processClaims(`The file has [[CLAIM src=file.lines path=${p}]] lines.`, opts());
		expect(out.allVerified).toBe(true);
		expect(out.text).toBe(`The file has 3 (verified: file.lines path=${p}) lines.`);
		expect(out.results[0].status).toBe("verified");
		expect(out.results[0].value).toBe("3");
	});
});

describe("processClaims - assertion mode (the checker catches lies)", () => {
	test("a correct assertion survives, marked verified", () => {
		const p = path.join(root, "three.txt");
		const out = processClaims(`[[CLAIM src=file.lines path=${p} expect=3]]`, opts());
		expect(out.allVerified).toBe(true);
		expect(out.results[0].status).toBe("verified");
	});

	test("a WRONG assertion is stripped and flagged with the verified value", () => {
		const p = path.join(root, "three.txt");
		const out = processClaims(
			`Security review done. [[CLAIM src=file.lines path=${p} expect=9999]]`,
			opts(),
		);
		expect(out.allVerified).toBe(false);
		expect(out.results[0].status).toBe("mismatch");
		// The officer's number does not survive; the strip flag and the true value do.
		expect(out.text).toContain("[CLAIM STRIPPED: asserted 9999");
		expect(out.text).toContain("verifies as 3]");
		expect(out.text).not.toMatch(/9999(?!,)/); // only inside the strip flag
	});

	test("an unknown extractor is stripped visibly, never passed through", () => {
		const out = processClaims("[[CLAIM src=made.up path=x]]", opts());
		expect(out.results[0].status).toBe("error");
		expect(out.text).toContain("[CLAIM STRIPPED: made.up");
	});

	test("a duplicate claim id strips the later claim and keeps the first binding", () => {
		const a = path.join(root, "three.txt");
		const b = path.join(root, "five.txt");
		const out = processClaims(
			`[[CLAIM id=c1 src=file.lines path=${a}]] [[CLAIM id=c1 src=file.lines path=${b}]] [[DERIVE op=sum of=c1,c1]]`,
			opts(),
		);
		expect(out.results[1].status).toBe("error");
		expect(out.results[1].reason).toContain("duplicate claim id");
		// The derivation binds to the FIRST c1 (3), never the ambiguous later one.
		const d = out.results.find((r) => r.kind === "derivation");
		expect(d?.status).toBe("verified");
		expect(d?.value).toBe("6");
	});

	test("a denied path is stripped visibly", () => {
		const out = processClaims("[[CLAIM src=file.lines path=/etc/passwd]]", opts());
		expect(out.results[0].status).toBe("error");
		expect(out.text).toContain("CLAIM STRIPPED");
	});
});

describe("processClaims - derivations (the model names the op, code computes)", () => {
	test("a ratio over two verified claims is computed by code", () => {
		const a = path.join(root, "three.txt");
		const b = path.join(root, "five.txt");
		const out = processClaims(
			`[[CLAIM id=c1 src=file.lines path=${a}]] [[CLAIM id=c2 src=file.lines path=${b}]] ratio: [[DERIVE op=ratio of=c1,c2]]`,
			opts(),
		);
		expect(out.allVerified).toBe(true);
		const d = out.results.find((r) => r.kind === "derivation");
		expect(d?.value).toBe("0.6");
	});

	test("a derivation over a stripped input is itself stripped", () => {
		const a = path.join(root, "three.txt");
		const out = processClaims(
			`[[CLAIM id=c1 src=file.lines path=${a} expect=42]] [[DERIVE op=sum of=c1,c1]]`,
			opts(),
		);
		const d = out.results.find((r) => r.kind === "derivation");
		expect(d?.status).toBe("error");
		expect(d?.reason).toContain("not a verified claim");
	});

	test("a wrong derived expect is caught", () => {
		const a = path.join(root, "three.txt");
		const b = path.join(root, "five.txt");
		const out = processClaims(
			`[[CLAIM id=c1 src=file.lines path=${a}]] [[CLAIM id=c2 src=file.lines path=${b}]] [[DERIVE op=sum of=c1,c2 expect=99]]`,
			opts(),
		);
		const d = out.results.find((r) => r.kind === "derivation");
		expect(d?.status).toBe("mismatch");
		expect(out.text).toContain("computes to 8");
	});

	test("division by zero is an error, not Infinity", () => {
		const a = path.join(root, "three.txt");
		fs.writeFileSync(path.join(root, "empty.txt"), "");
		const out = processClaims(
			`[[CLAIM id=c1 src=file.lines path=${a}]] [[CLAIM id=c2 src=file.lines path=${path.join(root, "empty.txt")}]] [[DERIVE op=ratio of=c1,c2]]`,
			opts(),
		);
		const d = out.results.find((r) => r.kind === "derivation");
		expect(d?.status).toBe("error");
		expect(d?.reason).toBe("division by zero");
	});
});

describe("processClaims - ledger recording", () => {
	test("every claim and derivation lands in the ledger and the chain verifies", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ledger-"));
		const ledger = Ledger.open({ runId: "run", baseDir: dir, key: Buffer.from("k".repeat(32)) });
		const a = path.join(root, "three.txt");
		const b = path.join(root, "five.txt");
		processClaims(
			`[[CLAIM id=c1 src=file.lines path=${a}]] [[CLAIM id=c2 src=file.lines path=${b} expect=1]] [[DERIVE op=sum of=c1,c2]]`,
			{ roots: [root], ledger, now: () => 1700000000000 },
		);
		const entries = ledger.readAll();
		expect(entries).toHaveLength(3);
		expect(entries[0].kind).toBe("verify.claim");
		expect(entries[1].payload.status).toBe("mismatch");
		expect(entries[2].kind).toBe("verify.derivation");
		// The derivation entry is replayable: it carries each input's reference AND value.
		const inputs = entries[2].payload.inputs as Array<{ src: string; value: string }>;
		expect(inputs[0].src).toBe("file.lines");
		expect(inputs[0].value).toBe("3");
		expect(ledger.verify().ok).toBe(true);
		ledger.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("hasClaimMarkers", () => {
	test("detects markers cheaply", () => {
		expect(hasClaimMarkers("x [[CLAIM src=a]]")).toBe(true);
		expect(hasClaimMarkers("x [[DERIVE op=sum of=a,b]]")).toBe(true);
		expect(hasClaimMarkers("plain text [[HELM cmd=ls]]")).toBe(false);
	});
});
