import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	HostCliClient,
	HostCliRateLimitError,
	HostCliUnavailableError,
	checkHostCliAvailability,
} from "./host-cli.js";
import { isHostCliAvailable } from "./index.js";

/**
 * Build a shell-script stub for a CLI and make it executable. Returns the
 * absolute path. The script echoes the given stdout and exits with the
 * given status, mimicking the behaviour of a real host CLI without
 * touching the network or any on-host session.
 */
function makeStub(dir: string, name: string, script: string): string {
	const p = join(dir, name);
	writeFileSync(p, script, { mode: 0o755 });
	chmodSync(p, 0o755);
	return p;
}

const tmp = mkdtempSync(join(tmpdir(), "8gent-hostcli-test-"));
const stubDir = join(tmp, "bin");
mkdirSync(stubDir, { recursive: true });

const originalPath = process.env.PATH;
const originalFlag = process.env.PROVIDERS_ALLOW_HOST_CLI;

// Two binary-spec shapes we need to cover: one uses `-p <prompt>` and
// surfaces rate limits as exit code 7, the other uses `exec <prompt>` and
// surfaces auth failures on a generic non-zero exit with a stderr hint.
beforeAll(() => {
	makeStub(stubDir, "stub-ok", "#!/bin/sh\necho ok\nexit 0\n");
	makeStub(
		stubDir,
		"stub-ratelimit",
		"#!/bin/sh\necho 'rate limit exceeded' >&2\nexit 7\n",
	);
	makeStub(stubDir, "stub-exec-ok", "#!/bin/sh\necho exec-ok\nexit 0\n");
	makeStub(
		stubDir,
		"stub-auth",
		"#!/bin/sh\necho 'please run login first' >&2\nexit 2\n",
	);

	process.env.PATH = `${stubDir}:${originalPath ?? ""}`;
});

afterAll(() => {
	process.env.PATH = originalPath;
	if (originalFlag === undefined) {
		delete process.env.PROVIDERS_ALLOW_HOST_CLI;
	} else {
		process.env.PROVIDERS_ALLOW_HOST_CLI = originalFlag;
	}
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("host-CLI delegation: availability gating", () => {
	it("reports unavailable when PROVIDERS_ALLOW_HOST_CLI is unset", () => {
		delete process.env.PROVIDERS_ALLOW_HOST_CLI;
		const result = checkHostCliAvailability("stub-ok");
		expect(result.available).toBe(false);
		expect(result.reason).toContain("PROVIDERS_ALLOW_HOST_CLI");
	});

	it("reports unavailable when binary is absent", () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const result = checkHostCliAvailability("stub-does-not-exist-zzz");
		expect(result.available).toBe(false);
		expect(result.reason).toContain("not found on PATH");
	});

	it("reports unavailable when no binary is configured", () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const result = checkHostCliAvailability("");
		expect(result.available).toBe(false);
		expect(result.reason).toContain("No host CLI binary configured");
	});

	it("reports available when flag set and binary on PATH", () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const result = checkHostCliAvailability("stub-ok");
		expect(result.available).toBe(true);
		expect(result.binary).toContain("stub-ok");
	});

	it("isHostCliAvailable reflects flag + binary presence", () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		expect(isHostCliAvailable("stub-ok")).toBe(true);
		expect(isHostCliAvailable("stub-does-not-exist-zzz")).toBe(false);
		delete process.env.PROVIDERS_ALLOW_HOST_CLI;
		expect(isHostCliAvailable("stub-ok")).toBe(false);
	});
});

describe("HostCliClient: primary-style spec (-p prompt, exit 7 rate limit)", () => {
	it("throws HostCliUnavailableError when flag is not set", async () => {
		delete process.env.PROVIDERS_ALLOW_HOST_CLI;
		const client = new HostCliClient({
			spec: { binary: "stub-ok", rateLimitExitCode: 7 },
		});
		await expect(
			client.chat([{ role: "user", content: "hi" }]),
		).rejects.toBeInstanceOf(HostCliUnavailableError);
	});

	it("returns stdout as the assistant message on success", async () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const client = new HostCliClient({
			spec: { binary: "stub-ok", rateLimitExitCode: 7 },
		});
		const res = await client.chat([{ role: "user", content: "ping" }]);
		expect(res.done).toBe(true);
		expect(res.message.role).toBe("assistant");
		expect(res.message.content).toBe("ok");
	});

	it("surfaces rate-limit exits as HostCliRateLimitError", async () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const client = new HostCliClient({
			spec: { binary: "stub-ratelimit", rateLimitExitCode: 7 },
		});
		try {
			await client.chat([{ role: "user", content: "ping" }]);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HostCliRateLimitError);
			const e = err as HostCliRateLimitError;
			expect(e.exitCode).toBe(7);
		}
	});
});

describe("HostCliClient: secondary-style spec (exec subcommand, auth via stderr)", () => {
	it("returns stdout on success", async () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const client = new HostCliClient({
			spec: {
				binary: "stub-exec-ok",
				buildArgs: (prompt, extra) => ["exec", prompt, ...extra],
			},
		});
		const res = await client.chat([{ role: "user", content: "hello" }]);
		expect(res.message.content).toBe("exec-ok");
	});

	it("maps auth failures to HostCliUnavailableError", async () => {
		process.env.PROVIDERS_ALLOW_HOST_CLI = "1";
		const client = new HostCliClient({
			spec: {
				binary: "stub-auth",
				buildArgs: (prompt, extra) => ["exec", prompt, ...extra],
			},
		});
		await expect(
			client.chat([{ role: "user", content: "hello" }]),
		).rejects.toBeInstanceOf(HostCliUnavailableError);
	});

	it("availability check is false when flag is missing", () => {
		delete process.env.PROVIDERS_ALLOW_HOST_CLI;
		expect(checkHostCliAvailability("stub-exec-ok").available).toBe(false);
	});
});
