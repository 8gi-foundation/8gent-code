/**
 * Doc-code drift gate (live-huddle amendment 4, applied to the spec itself).
 *
 * docs/specs/FLOW-TELEMETRY-SCHEMA.md is the field-level contract the Chair
 * approves. This test parses its field tables and diffs them against the
 * specs in flow-stream.ts. Changing one without the other fails CI, so the
 * document can never silently lie about what the code writes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVELOPE_FIELDS, FLOW_FIELDS, type FlowKind } from "./flow-stream";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "specs", "FLOW-TELEMETRY-SCHEMA.md");

/** Parse "### `kind` ..." sections and their `| `field` | type | required | access |` rows. */
function parseDocFields(markdown: string): Map<string, Map<string, { type: string; required: boolean; access: string }>> {
	const sections = new Map<string, Map<string, { type: string; required: boolean; access: string }>>();
	let current: Map<string, { type: string; required: boolean; access: string }> | null = null;
	for (const line of markdown.split("\n")) {
		const heading = line.match(/^###? .*?`(\w+)`|^## (Envelope)/);
		const sectionName = heading?.[1] ?? heading?.[2]?.toLowerCase();
		if (sectionName) {
			current = new Map();
			sections.set(sectionName, current);
			continue;
		}
		const row = line.match(/^\| `(\w+)` \| (\w+) \| (yes|no) \| ([\w-]+) \|/);
		if (row && current) {
			const [, field, type, required, access] = row;
			if (field && type && access) current.set(field, { type, required: required === "yes", access });
		}
	}
	return sections;
}

const doc = parseDocFields(readFileSync(DOC_PATH, "utf8"));

describe("schema doc matches code", () => {
	test("envelope fields agree", () => {
		const envelope = doc.get("envelope");
		expect(envelope).toBeDefined();
		expect([...(envelope?.keys() ?? [])].sort()).toEqual(Object.keys(ENVELOPE_FIELDS).sort());
	});

	test("every kind in code is documented with exactly the same fields", () => {
		for (const kind of Object.keys(FLOW_FIELDS) as FlowKind[]) {
			const documented = doc.get(kind);
			expect(documented, `kind ${kind} missing from schema doc`).toBeDefined();
			expect([...(documented?.keys() ?? [])].sort(), `field set drift on kind ${kind}`).toEqual(
				Object.keys(FLOW_FIELDS[kind]).sort(),
			);
			for (const [field, spec] of Object.entries(FLOW_FIELDS[kind])) {
				const row = documented?.get(field);
				expect(row?.type, `${kind}.${field} type drift`).toBe(spec.type);
				expect(row?.required, `${kind}.${field} required drift`).toBe(!spec.optional);
			}
		}
	});

	test("no documented kind is missing from code", () => {
		const documentedKinds = [...doc.keys()].filter((k) => k !== "envelope");
		expect(documentedKinds.sort()).toEqual(Object.keys(FLOW_FIELDS).sort());
	});

	test("every field in every kind is annotated local-only", () => {
		for (const [section, fields] of doc) {
			for (const [field, row] of fields)
				expect(row.access, `${section}.${field} must be local-only`).toBe("local-only");
		}
	});

	test("the cloud-prompt ban is stated in the doc", () => {
		const text = readFileSync(DOC_PATH, "utf8").replace(/\s+/g, " ");
		expect(text).toContain("NOTHING in this stream may enter a cloud model prompt");
	});
});
