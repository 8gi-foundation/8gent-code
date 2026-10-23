/**
 * The daemon on plain Node, through the entry a Termux install runs (#4852):
 * `node dist/node/cli.js daemon run`, the npm package's bin path, not Bun and not
 * a unit test of a piece. Needs `bun scripts/build-node.ts` first and skips when
 * the bundle or a real Node 22.5+ is missing. EIGHT_REQUIRE_NODE_BUNDLE makes that
 * a failure instead of a skip (node-bundle.test.ts has the sentinel).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(90000);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "node", "cli.js");
const check = join(root, "scripts", "daemon-attach-check.mjs");

function findNode22(): string | null {
	for (const n of [
		Bun.which("node"),
		"/opt/homebrew/opt/node@22/bin/node",
		"/usr/local/opt/node@22/bin/node",
	]) {
		if (!n || !isAbsolute(n)) continue;
		const r = spawnSync(n, ["-p", "process.versions.bun ? 'BUN' : process.versions.node"], {
			encoding: "utf8",
		});
		const out = (r.stdout ?? "").trim();
		if (r.status !== 0 || out === "BUN") continue;
		const [maj, min] = out.split(".").map(Number);
		if ((maj as number) > 22 || (maj === 22 && (min as number) >= 5)) return n;
	}
	return null;
}
const node = findNode22();
const ready = existsSync(cli) && node !== null;

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
		s.on("error", rej);
	});
}

function run(args: string[], env: Record<string, string>): ChildProcess & { out: () => string } {
	const child: ChildProcess = spawn(node as string, args, {
		env: {
			PATH: `${dirname(node as string)}:/usr/bin:/bin`,
			...env,
		} as unknown as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buf = "";
	child.stdout?.on("data", (d: Buffer) => void (buf += d));
	child.stderr?.on("data", (d: Buffer) => void (buf += d));
	return Object.assign(child, { out: () => buf });
}

async function until(fn: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await Bun.sleep(250);
	}
	return false;
}

test.skipIf(!process.env.EIGHT_REQUIRE_NODE_BUNDLE)(
	"required in CI: the Node bundle is built and Node 22.5+ is available for the daemon test",
	() => {
		expect(ready).toBe(true);
	},
);

describe.skipIf(!ready)("8gent daemon run, on Node", () => {
	test("starts, answers /health, lets a client list sessions over the WebSocket, stops on SIGTERM", async () => {
		const port = await freePort();
		const home = mkdtempSync(join(tmpdir(), "8gent-node-daemon-"));
		const daemon = run([cli, "daemon", "run"], {
			HOME: home,
			EIGHT_HOME: home,
			EIGHT_DAEMON_PORT: String(port),
		});
		const exited = new Promise<number | null>((r) => daemon.once("exit", (c) => r(c)));
		try {
			const up = await until(async () => {
				if (daemon.exitCode !== null) return true;
				try {
					return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
				} catch {
					return false;
				}
			}, 60000);
			expect(daemon.exitCode, `daemon died on start:\n${daemon.out()}`).toBeNull();
			expect(up, `daemon never answered /health:\n${daemon.out()}`).toBe(true);

			// The loopback guard still sees the peer: a foreign Host header is refused.
			const foreign = await fetch(`http://127.0.0.1:${port}/health`, {
				headers: { Host: "evil.example" },
			});
			expect(foreign.status).toBeGreaterThanOrEqual(400);

			// The same script the Termux smoke runs, under Node.
			const attach = spawnSync(node as string, [check, String(port)], { encoding: "utf8" });
			expect(attach.status, attach.stdout + attach.stderr).toBe(0);
			expect(attach.stdout).toContain("PASS  /health ok");
			expect(attach.stdout).toContain("PASS  WebSocket attach: sessions:list answered");
		} finally {
			daemon.kill("SIGTERM");
		}
		const stopped = await Promise.race([exited, Bun.sleep(20000).then(() => "hung" as const)]);
		if (stopped === "hung") daemon.kill("SIGKILL");
		rmSync(home, { recursive: true, force: true });
		expect(stopped, `daemon ignored SIGTERM:\n${daemon.out()}`).not.toBe("hung");
	});

	test("a daemon already on the port is reported, not doubled", async () => {
		const port = await freePort();
		const home = mkdtempSync(join(tmpdir(), "8gent-node-daemon-"));
		const first = run([cli, "daemon", "run"], {
			HOME: home,
			EIGHT_HOME: home,
			EIGHT_DAEMON_PORT: String(port),
		});
		try {
			expect(
				await until(async () => {
					try {
						return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
					} catch {
						return false;
					}
				}, 60000),
			).toBe(true);
			const second = spawnSync(node as string, [cli, "daemon", "run"], {
				encoding: "utf8",
				env: {
					PATH: dirname(node as string),
					HOME: home,
					EIGHT_HOME: home,
					EIGHT_DAEMON_PORT: String(port),
				} as unknown as NodeJS.ProcessEnv,
			});
			expect(second.status).not.toBeNull();
			expect(second.stdout + second.stderr).toMatch(/already|in use|port/i);
		} finally {
			first.kill("SIGTERM");
			await Bun.sleep(1500);
			rmSync(home, { recursive: true, force: true });
		}
	});
});
