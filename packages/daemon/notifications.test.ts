/**
 * Notification dispatcher guards (#2883).
 *
 * A notification is the system's most direct claim on a person's attention.
 * One with nothing to say costs that attention and returns nothing, so the
 * dispatcher refuses to post it - on every channel, from every call site.
 *
 * No real osascript and no real network here: Bun.spawn and fetch are spied,
 * so "did not post" is proven by the absence of the process/request, not by
 * the return value alone.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { NotificationDispatcher, isPostableBody, sendNativeNotification } from "./notifications";

type Spy = { mockRestore: () => void };
const spies: Spy[] = [];

afterEach(() => {
	while (spies.length > 0) spies.pop()?.mockRestore();
});

/** Replaces Bun.spawn so no osascript process can start during the suite. */
function spySpawn() {
	const spy = spyOn(Bun, "spawn").mockImplementation(
		() => ({ exited: Promise.resolve(0) }) as unknown as ReturnType<typeof Bun.spawn>,
	);
	spies.push(spy as unknown as Spy);
	return spy;
}

/** Replaces global fetch so no Telegram or Resend request can leave the box. */
function spyFetch() {
	// Bun's fetch type carries a `preconnect` member; a bare async function does
	// not, so the cast is what lets tsc accept a stub that only ever answers 200.
	const spy = spyOn(globalThis, "fetch").mockImplementation(
		(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
	);
	spies.push(spy as unknown as Spy);
	return spy;
}

describe("isPostableBody - what counts as something to say", () => {
	it("accepts a body that states the finding", () => {
		expect(isPostableBody("Deploy blocked on a missing Convex key")).toBe(true);
	});

	it("rejects an empty or whitespace-only body", () => {
		expect(isPostableBody("")).toBe(false);
		expect(isPostableBody("   \n\t ")).toBe(false);
	});

	it("rejects the generic placeholder macOS substitutes for an empty body", () => {
		// The exact alert the Chair received: title "8gent - reflection finding",
		// body "Notification".
		expect(isPostableBody("Notification")).toBe(false);
		expect(isPostableBody("  notification  ")).toBe(false);
	});

	it("rejects a stringified nullish value - a producer bug, never a message", () => {
		expect(isPostableBody("undefined")).toBe(false);
		expect(isPostableBody("null")).toBe(false);
	});

	it("accepts a real sentence that merely contains a placeholder word", () => {
		expect(isPostableBody("Notification pipeline is posting empty bodies")).toBe(true);
	});
});

describe("sendNativeNotification - no empty alert ever reaches the screen", () => {
	it("does not spawn osascript for an empty body", async () => {
		const spawn = spySpawn();
		const posted = await sendNativeNotification("8gent - reflection finding", "");
		expect(posted).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("does not spawn osascript for a whitespace-only body", async () => {
		const spawn = spySpawn();
		expect(await sendNativeNotification("8gent - reflection finding", "   ")).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("does not spawn osascript for the placeholder body", async () => {
		const spawn = spySpawn();
		expect(await sendNativeNotification("8gent - reflection finding", "Notification")).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.if(process.platform === "darwin")("still posts a body that carries content", async () => {
		const spawn = spySpawn();
		const posted = await sendNativeNotification("8gent - reflection finding", "Deploy blocked");
		expect(posted).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
		const argv = spawn.mock.calls[0][0] as string[];
		expect(argv[0]).toBe("osascript");
		expect(argv[2]).toContain("Deploy blocked");
	});
});

describe("NotificationDispatcher.notify - the guard covers Telegram too", () => {
	it("sends nothing at all for an empty message", async () => {
		const fetchSpy = spyFetch();
		const spawn = spySpawn();
		await new NotificationDispatcher("token", "chat-1").notify("task-failed", "");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("sends nothing at all for the placeholder message", async () => {
		const fetchSpy = spyFetch();
		const spawn = spySpawn();
		await new NotificationDispatcher("token", "chat-1").notify("task-complete", "Notification");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("still sends a message that carries content", async () => {
		const fetchSpy = spyFetch();
		spySpawn();
		await new NotificationDispatcher("token", "chat-1").notify("task-complete", "Build shipped");
		expect(fetchSpy).toHaveBeenCalled();
		const url = String(fetchSpy.mock.calls[0][0]);
		expect(url).toContain("/sendMessage");
	});
});
