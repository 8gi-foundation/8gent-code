import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@8gent/eyes";
import { frameToPayload, parseFlowConfig, serveFlow } from "./index.js";

function fixtureFrame(path: string): Frame {
	return {
		id: "frm_test",
		path,
		width: 1200,
		height: 800,
		displayId: 1,
		capturedAt: 123,
		scale: 2,
		platform: "darwin",
	};
}

function nextMessage(ws: WebSocket): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for message")), 2_000);
		ws.addEventListener(
			"message",
			(event) => {
				clearTimeout(timeout);
				resolve(JSON.parse(String(event.data)));
			},
			{ once: true },
		);
	});
}

describe("parseFlowConfig", () => {
	it("defaults to a token-gated loopback relay", () => {
		const parsed = parseFlowConfig(["serve"]);
		expect(parsed.subcommand).toBe("serve");
		expect(parsed.config.host).toBe("127.0.0.1");
		expect(parsed.config.port).toBe(8788);
		expect(parsed.config.path).toBe("/flow");
		expect(parsed.config.fps).toBe(1);
		expect(parsed.config.token).toBeTruthy();
		expect(parsed.config.includeImage).toBe(true);
		expect(parsed.config.allowControl).toBe(true);
	});

	it("supports LAN, on-demand, metadata-only iOS relay settings", () => {
		const parsed = parseFlowConfig([
			"serve",
			"--host",
			"0.0.0.0",
			"--port",
			"0",
			"--fps",
			"0",
			"--display",
			"primary",
			"--path",
			"ios-flow",
			"--format",
			"png",
			"--no-image",
		]);
		expect(parsed.config.host).toBe("0.0.0.0");
		expect(parsed.config.port).toBe(0);
		expect(parsed.config.fps).toBe(0);
		expect(parsed.config.displayId).toBe("primary");
		expect(parsed.config.path).toBe("/ios-flow");
		expect(parsed.config.format).toBe("png");
		expect(parsed.config.includeImage).toBe(false);
		expect(parsed.config.allowControl).toBe(true);
	});

	it("keeps control disabled on no-token relays unless explicitly allowed", () => {
		const noToken = parseFlowConfig(["serve", "--no-token"]);
		expect(noToken.config.token).toBeNull();
		expect(noToken.config.allowControl).toBe(false);

		const explicit = parseFlowConfig(["serve", "--no-token", "--allow-unauthenticated-control"]);
		expect(explicit.config.token).toBeNull();
		expect(explicit.config.allowControl).toBe(true);
	});
});

describe("frameToPayload", () => {
	it("omits local file paths and encodes image bytes", async () => {
		const dir = join(tmpdir(), `8gent-flow-test-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "frame.jpg");
		await writeFile(path, Buffer.from([1, 2, 3, 4]));

		const payload = await frameToPayload(fixtureFrame(path), {
			format: "jpeg",
			includeImage: true,
			maxFrameBytes: 100,
		});

		expect(payload.type).toBe("flow.frame");
		expect(payload.frame.id).toBe("frm_test");
		expect(payload.image?.mime).toBe("image/jpeg");
		expect(payload.image?.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
		expect(JSON.stringify(payload)).not.toContain(path);
	});

	it("omits oversized frames instead of sending them", async () => {
		const dir = join(tmpdir(), `8gent-flow-test-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "frame.jpg");
		await writeFile(path, Buffer.from([1, 2, 3, 4]));

		const payload = await frameToPayload(fixtureFrame(path), {
			format: "jpeg",
			includeImage: true,
			maxFrameBytes: 2,
		});

		expect(payload.image).toBeUndefined();
		expect(payload.omitted?.reason).toBe("frame-too-large");
		expect(payload.omitted?.bytes).toBe(4);
	});
});

describe("serveFlow", () => {
	it("requires a pair token before serving a requested frame", async () => {
		const dir = join(tmpdir(), `8gent-flow-test-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "frame.jpg");
		await writeFile(path, Buffer.from([8, 6, 1, 0]));

		const relay = await serveFlow(
			{
				host: "127.0.0.1",
				port: 0,
				path: "/flow",
				fps: 0,
				token: "pair-token",
				displayId: "primary",
				format: "jpeg",
				includeImage: true,
				maxFrameBytes: 100,
				allowControl: true,
			},
			{
				eyes: {
					async capture() {
						return fixtureFrame(path);
					},
				},
				now: () => 123,
			},
		);

		try {
			const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/flow`);
			const first = await nextMessage(ws);
			expect(first).toEqual({ type: "flow.auth_required", protocol: "8gent-flow.v1" });

			ws.send(JSON.stringify({ type: "hello", token: "pair-token" }));
			const ready = await nextMessage(ws);
			expect((ready as { type?: string }).type).toBe("flow.ready");

			ws.send(JSON.stringify({ type: "request_frame" }));
			const frame = await nextMessage(ws);
			expect((frame as { type?: string }).type).toBe("flow.frame");
			expect((frame as { image?: { data?: string } }).image?.data).toBe(
				Buffer.from([8, 6, 1, 0]).toString("base64"),
			);
			ws.close();
		} finally {
			relay.stop();
		}
	});

	it("dispatches authenticated control messages and refreshes the frame", async () => {
		const dir = join(tmpdir(), `8gent-flow-test-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "frame.jpg");
		await writeFile(path, Buffer.from([1, 3, 3, 7]));
		const clicks: Array<{ x: number; y: number; count?: number }> = [];

		const relay = await serveFlow(
			{
				host: "127.0.0.1",
				port: 0,
				path: "/flow",
				fps: 0,
				token: "pair-token",
				displayId: "primary",
				format: "jpeg",
				includeImage: true,
				maxFrameBytes: 100,
				allowControl: true,
			},
			{
				eyes: {
					async capture() {
						return fixtureFrame(path);
					},
				},
				control: {
					click(input) {
						clicks.push(input);
						return { ok: true };
					},
					hover() {
						return { ok: true };
					},
					scroll() {
						return { ok: true };
					},
					typeText() {
						return { ok: true };
					},
					press() {
						return { ok: true };
					},
				},
				now: () => 456,
			},
		);

		try {
			const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/flow`);
			await nextMessage(ws);
			ws.send(JSON.stringify({ type: "hello", token: "pair-token" }));
			await nextMessage(ws);

			ws.send(JSON.stringify({ type: "control.click", id: "tap-1", x: 42, y: 99, count: 1 }));
			const result = await nextMessage(ws);
			expect(result).toEqual({
				type: "control.result",
				protocol: "8gent-flow.v1",
				id: "tap-1",
				action: "control.click",
				ok: true,
			});
			expect(clicks).toEqual([{ x: 42, y: 99, count: 1 }]);

			const frame = await nextMessage(ws);
			expect((frame as { type?: string }).type).toBe("flow.frame");
			ws.close();
		} finally {
			relay.stop();
		}
	});
});
