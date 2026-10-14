/**
 * #4236: the model left .tmp/verify scratch inside the project (rm -rf was
 * correctly denied), failing SIGI work_committed_tree_clean. The prompt must
 * tell it to keep scratch under $TMPDIR, where rm -rf is permitted.
 */
import { describe, expect, it } from "bun:test";
import { RULES_SEGMENT } from "./system-prompt";

describe("scratch location rule", () => {
	it("tells the model to keep scratch outside the project under TMPDIR", () => {
		expect(RULES_SEGMENT).toContain("SCRATCH LIVES OUTSIDE THE PROJECT");
		expect(RULES_SEGMENT).toContain("mktemp -d");
		expect(RULES_SEGMENT).toContain("$TMPDIR");
	});

	it("matches the deny-list: rm -rf is allowed under TMPDIR, denied in the project", async () => {
		const { GO_DENY_LIST } = await import("../../permissions/go-deny-list");
		const rule = GO_DENY_LIST.find((r) => r.id === "rm-rf-outside-tmp");
		expect(rule?.match("run_command", "rm -rf .tmp/verify")).toBe(true);
		expect(rule?.match("run_command", 'rm -rf "$TMPDIR/scratch"')).toBe(false);
	});
});
