/**
 * JSON-RPC client tests against the fake Marlin sidecar fixture.
 * Exercises the ready handshake, request/reply, JSON-RPC errors, and the
 * process-failure path (VIDEO-INGESTION spec §4-5).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	MarlinSidecarClient,
	SidecarProcessError,
	SidecarRpcError,
	type SidecarSpawnSpec,
} from "../jsonrpc-client.js";

const FAKE = join(import.meta.dir, "fake-sidecar.ts");

function spawnSpec(mode: string): SidecarSpawnSpec {
	return { command: "bun", args: ["run", FAKE], env: { FAKE_MODE: mode } };
}

describe("MarlinSidecarClient", () => {
	test("starts, completes the ready handshake, and initializes", async () => {
		const client = await MarlinSidecarClient.start(spawnSpec("ok"));
		expect(client.pid).toBeGreaterThan(0);
		const init = (await client.request("initialize")) as { ready: boolean };
		expect(init.ready).toBe(true);
		await client.stop();
	});

	test("round-trips a caption request", async () => {
		const client = await MarlinSidecarClient.start(spawnSpec("ok"));
		await client.request("initialize");
		const cap = (await client.request("caption", { path: "/x.mp4", startSec: 0 })) as {
			events: unknown[];
		};
		expect(cap.events).toHaveLength(2);
		await client.stop();
	});

	test("surfaces a JSON-RPC error as SidecarRpcError with the code", async () => {
		const client = await MarlinSidecarClient.start(spawnSpec("rpc-error"));
		await client.request("initialize");
		try {
			await client.request("caption", { path: "/x.mp4" });
			throw new Error("expected SidecarRpcError");
		} catch (e) {
			expect(e).toBeInstanceOf(SidecarRpcError);
			expect((e as SidecarRpcError).code).toBe(-33002);
		}
		await client.stop();
	});

	test("rejects start when the sidecar never emits ready", async () => {
		try {
			await MarlinSidecarClient.start(spawnSpec("no-ready"), { readyTimeoutMs: 400 });
			throw new Error("expected a ready-timeout failure");
		} catch (e) {
			expect(e).toBeInstanceOf(SidecarProcessError);
		}
	});

	test("rejects in-flight requests when the process exits", async () => {
		const client = await MarlinSidecarClient.start(spawnSpec("crash-once"));
		await client.request("initialize");
		try {
			await client.request("caption", { path: "/x.mp4" });
			throw new Error("expected a process failure");
		} catch (e) {
			expect(e).toBeInstanceOf(SidecarProcessError);
		}
		expect(client.hasExited).toBe(true);
	});

	test("rejects a call made after the process has exited", async () => {
		const client = await MarlinSidecarClient.start(spawnSpec("crash-once"));
		await client.request("initialize");
		await client.request("caption", { path: "/x.mp4" }).catch(() => {});
		// Process is gone; a fresh call must fail fast, not hang.
		await expect(client.request("health")).rejects.toBeInstanceOf(SidecarProcessError);
	});
});
