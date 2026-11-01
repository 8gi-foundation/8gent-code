import { describe, expect, test } from "bun:test";
import { DEFAULT_SYSTEM_PROMPT } from "../prompt";
import { ARCHITECTURE_SEGMENT, workingProjectNote } from "./system-prompt";

// #4381: the model copied its own source folder name into a checklist for another project.
describe("working project context (#4381)", () => {
	test("names the actual project folder, whatever it is", () => {
		expect(workingProjectNote("/home/ana/invoice-tool")).toContain("`invoice-tool`");
		expect(workingProjectNote("/tmp/run-7/work")).toContain("`work`");
		expect(workingProjectNote("/")).toContain("`/`");
	});

	test("the harness name is no project folder in the prompts the model reads", () => {
		for (const text of [DEFAULT_SYSTEM_PROMPT, ARCHITECTURE_SEGMENT]) {
			expect(text).not.toMatch(/^8gent-code\/$/m);
			expect(text).not.toContain("/8gent-code/server.ts");
			expect(text).toContain("not the user's project");
		}
	});
});
