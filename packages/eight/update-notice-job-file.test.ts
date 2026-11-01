import { expect, test } from "bun:test";
import { maybeUpdateNotice } from "./update-notice";

function deps(report: (s: unknown) => void, cached: boolean) {
	return {
		now: () => 1_000_000,
		readState: () => (cached ? { checkedAt: 999_000 } : null),
		writeState: () => {},
		check: async () => ({ from: "1.0.0", to: "1.1.0" }),
		current: async () => "1.0.0",
		disabled: () => false,
		report,
	};
}

test("a real check reports running then done; a cached answer reports nothing", async () => {
	const seen: { state: string; detail: string }[] = [];
	await maybeUpdateNotice(deps((s) => seen.push(s as never), false));
	expect(seen.map((s) => s.state)).toEqual(["running", "done"]);
	expect(seen[1].detail).toContain("1.1.0");
	const none: unknown[] = [];
	await maybeUpdateNotice(deps((s) => none.push(s), true));
	expect(none).toEqual([]);
});

test("a throwing reporter never breaks the check", async () => {
	const out = await maybeUpdateNotice(
		deps(() => {
			throw new Error("disk full");
		}, false),
	);
	expect(out).toContain("1.1.0");
});
