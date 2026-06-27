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
});
