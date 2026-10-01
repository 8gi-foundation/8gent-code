import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	envIdentities,
	findOwnerIdentity,
	identitiesFromAuthorLog,
	isScannableIdentity,
	maskIdentity,
	repoAuthorIdentities,
} from "./owner-identity-scan";

const ROOT = join(import.meta.dir, "..", "..");

describe("owner-identity scan - identity collection", () => {
	test("keeps full names and real emails, drops bots, no-reply and single words", () => {
		const log = [
			"Ada Quill\x00ada.quill@example.test",
			"github-actions[bot]\x0041898282+github-actions[bot]@users.noreply.github.com",
			"adaq\x00123+adaq@users.noreply.github.com",
			"Claude\x00",
		].join("\n");
		expect(identitiesFromAuthorLog(log).sort()).toEqual(["Ada Quill", "ada.quill@example.test"]);
		expect(isScannableIdentity("Bo")).toBe(false);
	});

	test("env identities are comma separated and filtered", () => {
		expect(envIdentities(" Ada Quill , x , ada@example.test")).toEqual([
			"Ada Quill",
			"ada@example.test",
		]);
		expect(envIdentities(undefined)).toEqual([]);
	});

	test("matches names exactly and emails case-insensitively", () => {
		const src = `const A = "Ada Quill"; const B = "ADA@EXAMPLE.TEST"; const C = "ada quill";`;
		expect(findOwnerIdentity(src, ["Ada Quill", "ada@example.test", "Bo Tanaka"])).toEqual([
			"Ada Quill",
			"ada@example.test",
		]);
	});

	test("masks values for logs", () => {
		expect(maskIdentity("Ada Quill")).toBe("Ad***");
		expect(maskIdentity("ada@example.test")).toBe("ad***@example.test");
	});
});

describe("owner-identity scan - the shipped anonymizer", () => {
	test("bundling the PII anonymizer bakes in no commit author's name or email", async () => {
		const identities = repoAuthorIdentities(ROOT);
		// The checkout must have at least one author for the gate to mean anything.
		expect(identities.length).toBeGreaterThan(0);

		const built = await Bun.build({
			entrypoints: [join(ROOT, "packages", "permissions", "pii-anonymizer.ts")],
			target: "bun",
		});
		expect(built.success).toBe(true);
		const src = await built.outputs[0].text();
		expect(findOwnerIdentity(src, identities).map(maskIdentity)).toEqual([]);
	});
});
