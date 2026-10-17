import { describe, expect, test } from "bun:test";
import { maybeUpdateNotice, realNoticeDeps } from "../../../../packages/eight/update-notice.js";
import { checkForUpdate, isUpdateCheckEnabled } from "../hooks/useUpdateCheck.js";

describe("update check is opt-in", () => {
	test("off by default", () => {
		expect(isUpdateCheckEnabled({})).toBe(false);
		expect(isUpdateCheckEnabled({ EIGHT_UPDATE_CHECK: "0" })).toBe(false);
		expect(isUpdateCheckEnabled({ EIGHT_UPDATE_CHECK: "" })).toBe(false);
	});

	test("on with an explicit env", () => {
		expect(isUpdateCheckEnabled({ EIGHT_UPDATE_CHECK: "1" })).toBe(true);
		expect(isUpdateCheckEnabled({ EIGHT_UPDATE_CHECK: "true" })).toBe(true);
	});

	test("default makes no network call", async () => {
		let calls = 0;
		const fetchFn = (async () => {
			calls++;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const res = await checkForUpdate({}, "0.1.0", fetchFn);
		expect(res).toBeNull();
		expect(calls).toBe(0);
	});

	test("opted in reports a newer version", async () => {
		const fetchFn = (async () =>
			new Response(JSON.stringify({ version: "9.9.9" }))) as unknown as typeof fetch;
		const res = await checkForUpdate({ EIGHT_UPDATE_CHECK: "1" }, "0.1.0", fetchFn);
		expect(res).toEqual({ available: true, latest: "9.9.9", current: "0.1.0" });
	});

	test("launch notice path makes zero calls by default", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return new Response("[]");
		}) as never;
		const exec = (async () => {
			calls++;
			return { code: 1, stdout: "", stderr: "" };
		}) as never;
		const base = {
			currentVersion: "0.1.0",
			modulePath: "/x/y.js",
			embedded: true,
			fetchImpl,
			exec,
		};
		const off = realNoticeDeps({ ...base, env: { HOME: "/nonexistent" } });
		expect(await maybeUpdateNotice(off)).toBeNull();
		expect(calls).toBe(0);
		const hard = realNoticeDeps({
			...base,
			env: { HOME: "/nonexistent", EIGHT_UPDATE_CHECK: "1", EIGHT_NO_UPDATE_CHECK: "1" },
		});
		expect(hard.disabled()).toBe(true);
		const on = realNoticeDeps({ ...base, env: { HOME: "/nonexistent", EIGHT_UPDATE_CHECK: "1" } });
		expect(on.disabled()).toBe(false);
	});
});
