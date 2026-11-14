/**
 * Linux sandbox tests (8gi-governance#1108 lane 3).
 *
 * Argument building, the seccomp program and the unavailable path are pure and run on every
 * platform, macOS included. The live suite runs only on Linux with a working bubblewrap and
 * proves the seatbelt done-criteria hold there too: no reading the credential store, no
 * writing outside the work dir, no network, and the seccomp filter is in force.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BWRAP_SYSTEM_RO,
	type PathKind,
	buildBwrapArgs,
	buildBwrapArgv,
	bwrapStatus,
} from "./bwrap";
import { runSandboxed } from "./sandbox";
import {
	DENIED_SYSCALLS,
	buildSeccompProgram,
	encodeSeccompProgram,
	seccompArchFor,
} from "./seccomp-bpf";

const HOME = "/home/eight";
const WORK = "/home/eight/project";
const KINDS: Record<string, PathKind> = {
	"/home/eight/.ssh": "dir",
	"/home/eight/.netrc": "file",
	"/home/eight/.aws": "missing",
};
const kind = (p: string): PathKind => KINDS[p] ?? "missing";
const DENY = ["/home/eight/.ssh", "/home/eight/.netrc", "/home/eight/.aws"];

/** Pairs like ["--bind", src, dst] flattened back out for assertions. */
function triples(args: string[], flag: string): string[] {
	const out: string[] = [];
	args.forEach((a, i) => {
		if (a === flag) out.push(args[i + 1]);
	});
	return out;
}

describe("buildBwrapArgs: deny by default", () => {
	test("unshares every namespace, drops caps, clears env, new session", () => {
		const args = buildBwrapArgs({ workDir: WORK, denyPaths: DENY }, kind);
		expect(args).toContain("--unshare-all");
		expect(args).not.toContain("--share-net");
		expect(args).toContain("--die-with-parent");
		expect(args).toContain("--new-session");
		expect(args).toContain("--clearenv");
		expect(args.join(" ")).toContain("--cap-drop ALL");
	});

	test("network is shared only when allowed, with the resolver dirs", () => {
		const off = buildBwrapArgs({ workDir: WORK, denyPaths: [] }, kind);
		const on = buildBwrapArgs({ workDir: WORK, denyPaths: [], allowNetwork: true }, kind);
		expect(off).not.toContain("--share-net");
		expect(off).not.toContain("/run/systemd/resolve");
		expect(on).toContain("--share-net");
		expect(triples(on, "--ro-bind-try")).toContain("/run/systemd/resolve");
	});

	test("only system dirs, the work dir and granted scopes are mounted", () => {
		const args = buildBwrapArgs({ workDir: WORK, denyPaths: [] }, kind);
		const mounted = [
			...triples(args, "--ro-bind-try"),
			...triples(args, "--bind"),
			...triples(args, "--bind-try"),
		];
		expect(mounted.sort()).toEqual([...BWRAP_SYSTEM_RO, WORK].sort());
		for (const absent of ["/", "/home", HOME, "/root", "/run", "/var", "/sys", "/mnt"]) {
			expect(mounted).not.toContain(absent);
		}
		expect(triples(args, "--bind")).toEqual([WORK]);
		expect(args.slice(-2)).toEqual(["--chdir", WORK]);
	});

	test("read scopes are read-only, write scopes writable, ordered shallow to deep", () => {
		const args = buildBwrapArgs(
			{
				workDir: WORK,
				readPaths: [`${WORK}/vendor`, "/srv/data"],
				writePaths: ["/srv"],
				denyPaths: [],
			},
			kind,
		);
		expect(triples(args, "--ro-bind-try")).toContain(`${WORK}/vendor`);
		expect(triples(args, "--bind-try")).toEqual(["/srv"]);
		// /srv (depth 1) before /srv/data (2); work dir (3) before its vendor child (4).
		const pos = (p: string) =>
			args.findIndex((a, i) => /^--(ro-)?bind(-try)?$/.test(a) && args[i + 1] === p);
		expect(pos("/srv")).toBeLessThan(pos("/srv/data"));
		expect(pos(WORK)).toBeLessThan(pos(`${WORK}/vendor`));
	});

	test("credential stores inside a granted scope are masked last", () => {
		const args = buildBwrapArgs({ workDir: WORK, readPaths: [HOME], denyPaths: DENY }, kind);
		const s = args.join(" ");
		expect(s).toContain("--tmpfs /home/eight/.ssh --remount-ro /home/eight/.ssh");
		expect(s).toContain("--ro-bind /dev/null /home/eight/.netrc");
		expect(s).not.toContain("/home/eight/.aws"); // missing on host: nothing to hide
		const lastBind = Math.max(
			...args.flatMap((a, i) => (["--bind", "--bind-try", "--ro-bind-try"].includes(a) ? [i] : [])),
		);
		expect(args.indexOf("/home/eight/.ssh")).toBeGreaterThan(lastBind);
		expect(args.indexOf("/home/eight/.netrc")).toBeGreaterThan(lastBind);
	});

	test("credential stores outside every scope are not mentioned at all", () => {
		const args = buildBwrapArgs({ workDir: WORK, denyPaths: DENY }, kind);
		expect(args.join(" ")).not.toContain(".ssh");
	});

	test("a scope inside a credential store is dropped, a work dir there is refused", () => {
		const args = buildBwrapArgs(
			{
				workDir: WORK,
				readPaths: ["/home/eight/.ssh/keys"],
				writePaths: ["/home/eight/.ssh"],
				denyPaths: DENY,
			},
			kind,
		);
		expect(args.join(" ")).not.toContain(".ssh");
		expect(() => buildBwrapArgs({ workDir: "/home/eight/.ssh/x", denyPaths: DENY }, kind)).toThrow(
			/credential store/,
		);
	});

	test("relative paths are refused", () => {
		expect(() => buildBwrapArgs({ workDir: "project", denyPaths: [] }, kind)).toThrow(/absolute/);
		expect(() =>
			buildBwrapArgs({ workDir: WORK, readPaths: ["../etc"], denyPaths: [] }, kind),
		).toThrow(/absolute/);
	});

	test("env is set explicitly; seccomp fd is passed; argv ends with the shell", () => {
		const argv = buildBwrapArgv(
			"/usr/bin/bwrap",
			{ workDir: WORK, denyPaths: [], env: { PATH: "/usr/bin", HOME: WORK }, seccompFd: 3 },
			"echo hi",
			kind,
		);
		expect(argv[0]).toBe("/usr/bin/bwrap");
		expect(argv.join(" ")).toContain("--setenv PATH /usr/bin --setenv HOME /home/eight/project");
		expect(argv.join(" ")).toContain("--seccomp 3");
		expect(argv.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo hi"]);
	});
});

describe("seccomp program", () => {
	for (const arch of ["x64", "arm64"] as const) {
		test(`${arch}: checks arch first, denies the list, allows by default`, () => {
			const prog = buildSeccompProgram(arch);
			expect(prog[0]).toEqual({ code: 0x20, jt: 0, jf: 0, k: 4 });
			expect(prog[2]).toEqual({ code: 0x06, jt: 0, jf: 0, k: 0x80000000 });
			expect(prog.at(-1)).toEqual({ code: 0x06, jt: 0, jf: 0, k: 0x7fff0000 });
			const deniedNrs = prog
				.filter((p, i) => p.code === 0x15 && prog[i + 1]?.k === 0x00050001)
				.map((p) => p.k);
			for (const [name, nrs] of Object.entries(DENIED_SYSCALLS)) {
				expect({ name, hit: deniedNrs.includes(nrs[arch]) }).toEqual({ name, hit: true });
			}
			expect(prog.length).toBeLessThan(4096);
		});
	}

	test("x64 table refuses the x32 ABI", () => {
		const prog = buildSeccompProgram("x64");
		expect(prog.some((p) => p.code === 0x35 && p.k === 0x40000000)).toBe(true);
		expect(buildSeccompProgram("arm64").some((p) => p.code === 0x35)).toBe(false);
	});

	test("clone with CLONE_NEWUSER is refused, clone3 gets ENOSYS", () => {
		const prog = buildSeccompProgram("arm64");
		const i = prog.findIndex((p) => p.code === 0x15 && p.k === 220);
		expect(prog[i]).toMatchObject({ jt: 0, jf: 3 });
		expect(prog[i + 2]).toMatchObject({ code: 0x45, k: 0x10000000 });
		expect(prog[i + 3].k).toBe(0x00050001);
		expect(prog[i + 4].k).toBe(0x7fff0000);
		const c3 = prog.findIndex((p) => p.code === 0x15 && p.k === 435);
		expect(prog[c3 + 1].k).toBe(0x00050000 | 38);
	});

	test("encodes as 8-byte little-endian sock_filter records", () => {
		const bytes = encodeSeccompProgram([{ code: 0x15, jt: 1, jf: 2, k: 0xc000003e }]);
		expect([...bytes]).toEqual([0x15, 0x00, 0x01, 0x02, 0x3e, 0x00, 0x00, 0xc0]);
	});

	test("unknown architectures get no table", () => {
		expect(seccompArchFor("ia32")).toBeUndefined();
		expect(seccompArchFor("arm64")).toBe("arm64");
	});
});

describe("never silently unsandboxed", () => {
	test.if(process.platform !== "linux")(
		"bwrap off Linux returns unavailable and does not run",
		async () => {
			const marker = path.join(os.tmpdir(), `bwrap-marker-${process.pid}`);
			const r = await runSandboxed(`touch ${marker}`, { isolation: "bwrap" });
			expect(r.unavailable).toMatch(/Linux only/);
			expect(r.exitCode).toBe(126);
			expect(r.isolation).toBe("bwrap");
			expect(fs.existsSync(marker)).toBe(false);
			expect(bwrapStatus().available).toBe(false);
		},
	);

	test("microvm is refused, not downgraded", async () => {
		const r = await runSandboxed("echo ran", { isolation: "microvm" });
		expect(r.unavailable).toBeDefined();
		expect(r.stdout).toBe("");
	});

	test.if(process.platform !== "darwin")(
		"seatbelt off macOS is refused, not downgraded",
		async () => {
			const r = await runSandboxed("echo ran", { isolation: "seatbelt" });
			expect(r.unavailable).toMatch(/macOS only/);
			expect(r.stdout).toBe("");
		},
	);

	test("requireOsIsolation refuses a temp-dir run", async () => {
		const r = await runSandboxed("echo ran", { isolation: "tempdir", requireOsIsolation: true });
		expect(r.unavailable).toMatch(/kernel-enforced/);
		expect(r.stdout).toBe("");
	});
});

// ============================================
// Live enforcement (Linux with a working bubblewrap only)
// ============================================

const live = process.platform === "linux" && bwrapStatus().available;

describe.if(live)("bwrap live enforcement (Linux)", () => {
	// Created only when the suite runs (fixtures under the per-run temp dir).
	const root = path.join(os.tmpdir(), `bw-live-${process.pid}`);
	const WORKSPACE = path.join(root, "work");
	const OUTSIDE = path.join(root, "outside");
	const FAKE_HOME = path.join(root, "home");
	const SSH_KEY = path.join(FAKE_HOME, ".ssh", "id_ed25519");
	const run = (cmd: string, extra: Parameters<typeof runSandboxed>[1] = {}) =>
		runSandboxed(cmd, { isolation: "bwrap", workDir: WORKSPACE, ...extra });

	beforeAll(() => {
		for (const d of [WORKSPACE, OUTSIDE, path.dirname(SSH_KEY)])
			fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(WORKSPACE, "hello.txt"), "workspace file");
		fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "outside-secret");
		fs.writeFileSync(path.join(FAKE_HOME, "notes.txt"), "notes");
		fs.writeFileSync(SSH_KEY, "PRIVATE KEY MATERIAL");
		process.env.EIGHT_FAKE_HOME = FAKE_HOME;
	});
	afterAll(() => {
		// biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
		delete process.env.EIGHT_FAKE_HOME;
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("runs, reads and writes inside the work dir", async () => {
		const r = await run("cat hello.txt && echo written > out.txt && cat out.txt");
		expect(r.isolation).toBe("bwrap");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("workspace file");
		expect(r.stdout).toContain("written");
	});

	test("cannot see outside paths or the real home", async () => {
		const r = await run(`cat ${OUTSIDE}/secret.txt; ls ${os.homedir()}`);
		expect(r.stdout).not.toContain("outside-secret");
		expect(r.exitCode).not.toBe(0);
	});

	test("cannot write outside the work dir", async () => {
		const r = await run(`echo escaped > ${OUTSIDE}/escaped.txt`);
		expect(r.exitCode).not.toBe(0);
		expect(fs.existsSync(path.join(OUTSIDE, "escaped.txt"))).toBe(false);
	});

	test("granted home is readable, its .ssh is not", async () => {
		const ok = await run(`cat ${FAKE_HOME}/notes.txt`, { readPaths: [FAKE_HOME] });
		expect(ok.stdout).toContain("notes");
		const key = await run(`cat ${SSH_KEY}`, { readPaths: [FAKE_HOME] });
		expect(key.stdout).not.toContain("PRIVATE KEY");
		expect(key.exitCode).not.toBe(0);
	});

	test("no network by default", async () => {
		const r = await run(
			"cat /sys/class/net/*/operstate 2>/dev/null; getent hosts example.com || echo no-net",
		);
		expect(r.stdout).toContain("no-net");
	});

	test("seccomp refuses a new user namespace", async () => {
		const r = await run("unshare -U true && echo unshared || echo refused");
		expect(r.stdout).toContain("refused");
	});

	test("timeout kills the sandboxed tree", async () => {
		const r = await run("sleep 30", { timeout: 500 });
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBe(124);
	});
});
