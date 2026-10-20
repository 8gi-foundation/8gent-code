/**
 * scripts/install.sh against a fake release site served on 127.0.0.1 (the
 * only non-https origin the installer accepts). The "binary" is a shell
 * script that prints "8gent Code vX.Y.Z", which is all the installer runs.
 * `minisign` and `gh` are fakes on PATH, so the verification branches are
 * exercised without network or keys.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "install.sh");

function hostAsset(): string {
	let arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "darwin" && arch === "x64") {
		const r = Bun.spawnSync(["sysctl", "-n", "hw.optional.arm64"]);
		if (r.stdout.toString().trim() === "1") arch = "arm64";
	}
	return `8gent-${process.platform === "darwin" ? "darwin" : "linux"}-${arch}`;
}

const ASSET = hostAsset();
const fakeBinary = (version: string) => `#!/bin/sh\necho "8gent Code v${version}"\n`;

/** path -> body, or a redirect */
let routes = new Map<
	string,
	{ body?: string | Uint8Array; location?: string; failTimes?: number }
>();
let seenAuth: Array<string | null> = [];
let hits = 0;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const r = routes.get(new URL(req.url).pathname);
			if (new URL(req.url).pathname === "/missing.json") hits += 1;
			if (new URL(req.url).pathname === "/releases.json")
				seenAuth.push(req.headers.get("authorization"));
			if (!r) return new Response("not found", { status: 404 });
			if (r.failTimes && r.failTimes > 0) {
				r.failTimes -= 1;
				return new Response("rate limited", { status: 403 });
			}
			if (r.location) return new Response(null, { status: 302, headers: { location: r.location } });
			return new Response(r.body ?? "");
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let root: string;
let installDir: string;
let fakeBin: string;

interface FakeRelease {
	tag: string;
	assets: Record<string, string>;
	sums?: boolean;
	badSum?: boolean;
	prerelease?: boolean;
	minisig?: boolean;
	/** override one asset's URL */
	urlOverride?: Record<string, string>;
}

function publish(releases: FakeRelease[]): string {
	routes = new Map();
	const list = releases.map((r) => {
		const lines: string[] = [];
		const names = Object.keys(r.assets);
		for (const name of names) {
			routes.set(`/releases/download/${r.tag}/${name}`, { body: r.assets[name] });
			let sum = createHash("sha256").update(r.assets[name]).digest("hex");
			if (r.badSum && name === ASSET) sum = "0".repeat(64);
			lines.push(`${sum}  ${name}`);
		}
		const all = [...names];
		if (r.sums !== false) {
			routes.set(`/releases/download/${r.tag}/SHA256SUMS`, { body: `${lines.join("\n")}\n` });
			all.push("SHA256SUMS");
		}
		if (r.minisig) {
			routes.set(`/releases/download/${r.tag}/SHA256SUMS.minisig`, { body: "fake signature\n" });
			all.push("SHA256SUMS.minisig");
		}
		// GitHub's key order: tag_name, draft, prerelease, then assets.
		return {
			tag_name: r.tag,
			draft: false,
			prerelease: r.prerelease ?? false,
			body: 'Notes quoting \\"prerelease\\": true and \\"tag_name\\": \\"v99.0.0\\"',
			assets: all.map((name) => ({
				name,
				browser_download_url: r.urlOverride?.[name] ?? `${base}/releases/download/${r.tag}/${name}`,
			})),
		};
	});
	routes.set("/releases.json", { body: JSON.stringify(list, null, 2) });
	return `${base}/releases.json`;
}

function tool(name: string, script: string) {
	writeFileSync(join(fakeBin, name), `#!/bin/sh\n${script}\n`);
	chmodSync(join(fakeBin, name), 0o755);
}

async function install(releasesUrl: string, env: Record<string, string> = {}, args: string[] = []) {
	const p = Bun.spawn(["sh", SCRIPT, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: root,
			TMPDIR: root,
			EIGHT_RELEASES_URL: releasesUrl,
			EIGHT_INSTALL_DIR: installDir,
			...env,
		},
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { code: await p.exited, out: `${out}${err}` };
}

const installed = () => {
	const p = join(installDir, "8gent");
	if (!existsSync(p)) return null;
	return Bun.spawnSync([p, "--version"]).stdout.toString().trim();
};

const one = (v: string, extra: Partial<FakeRelease> = {}) =>
	publish([{ tag: `v${v}`, assets: { [ASSET]: fakeBinary(v) }, ...extra }]);

beforeEach(() => {
	root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "install-sh-"));
	installDir = join(root, "bin");
	fakeBin = join(root, "fakebin");
	mkdirSync(fakeBin, { recursive: true });
	// A real, signed-in gh on the test machine must not take part.
	tool("gh", "exit 1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install.sh: choosing a release", () => {
	test("installs the newest release that carries this machine's binary", async () => {
		const url = publish([
			{ tag: "v0.21.0", assets: {} },
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0"), "other.tgz": "x" } },
			{ tag: "v0.9.0", assets: { [ASSET]: fakeBinary("0.9.0") } },
			{ tag: "desktop-v9.0.0", assets: { [ASSET]: fakeBinary("9.0.0") } },
		]);
		const r = await install(url);
		expect(r.out).toContain("Installed 8gent v0.20.0");
		expect(r.code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
	});

	test("skips prereleases", async () => {
		const url = publish([
			{ tag: "v0.30.0", assets: { [ASSET]: fakeBinary("0.30.0") }, prerelease: true },
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") } },
		]);
		expect((await install(url)).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
	});

	test("compares versions numerically, not as text", async () => {
		const url = publish([
			{ tag: "v0.9.0", assets: { [ASSET]: fakeBinary("0.9.0") } },
			{ tag: "v0.10.0", assets: { [ASSET]: fakeBinary("0.10.0") } },
		]);
		expect((await install(url)).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.10.0");
	});

	test("EIGHT_VERSION pins a release, with or without the v", async () => {
		const url = publish([
			{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.20.0") } },
			{ tag: "v0.19.2", assets: { [ASSET]: fakeBinary("0.19.2") } },
		]);
		expect((await install(url, { EIGHT_VERSION: "v0.19.2" })).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.19.2");
	});

	test("says so plainly when no release has a binary yet", async () => {
		const r = await install(publish([{ tag: "v0.19.0", assets: {} }]));
		expect(r.code).not.toBe(0);
		expect(r.out).toContain(`no release carries a ${ASSET} binary`);
	});
});

describe("install.sh: release list retry (#4468)", () => {
	const fast = { EIGHT_TEST_RETRY_DELAY: "0" };

	test("a list that fails twice and then answers still installs", async () => {
		const url = one("0.20.0");
		routes.get("/releases.json")!.failTimes = 2;
		const r = await install(url, fast);
		expect(r.code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
	});

	test("gives up after 3 retries and names the last HTTP status", async () => {
		const url = one("0.20.0");
		routes.get("/releases.json")!.failTimes = 99;
		const r = await install(url, fast);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("could not read the release list");
		expect(r.out).toContain("last status: 403");
		expect(installed()).toBeNull();
	});

	test("403 then 200 succeeds, 404 fails at once with no retries", async () => {
		const url = one("0.20.0");
		routes.get("/releases.json")!.failTimes = 1;
		expect((await install(url, fast)).code).toBe(0);
		hits = 0;
		const r = await install(`${base}/missing.json`, fast);
		expect(hits).toBe(1);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("last status: 404");
	});

	test("EIGHT_INSTALL_GITHUB_TOKEN is never required and is not sent to a local server; GITHUB_TOKEN is ignored", async () => {
		const url = one("0.20.0");
		seenAuth = [];
		expect((await install(url, fast)).code).toBe(0);
		expect(
			(
				await install(url, {
					...fast,
					EIGHT_INSTALL_GITHUB_TOKEN: "tok-secret",
					GITHUB_TOKEN: "stale",
				})
			).code,
		).toBe(0);
		expect(seenAuth.every((a) => a === null)).toBe(true);
	});
});

describe("install.sh: transport", () => {
	test("refuses a non-https releases URL other than 127.0.0.1", async () => {
		for (const u of ["http://example.com/releases.json", "file:///tmp/releases.json"]) {
			const r = await install(u);
			expect(r.code).not.toBe(0);
			expect(r.out).toContain("must be https");
		}
	});

	test("refuses an asset URL on another host", async () => {
		const url = one("0.20.0", {
			urlOverride: { [ASSET]: `http://example.com/releases/download/v0.20.0/${ASSET}` },
		});
		const r = await install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("refusing");
		expect(installed()).toBeNull();
	});

	test("follows an allowed redirect and refuses one to another host", async () => {
		let url = one("0.20.0");
		const real = routes.get(`/releases/download/v0.20.0/${ASSET}`);
		routes.set(`/releases/download/v0.20.0/${ASSET}`, { location: `${base}/cdn/blob` });
		routes.set("/cdn/blob", real ?? {});
		expect((await install(url)).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");

		rmSync(installDir, { recursive: true, force: true });
		url = one("0.20.0");
		routes.set(`/releases/download/v0.20.0/${ASSET}`, { location: "http://evil.example/blob" });
		const r = await install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("refusing a redirect");
		expect(installed()).toBeNull();
	});
});

describe("install.sh: verification", () => {
	test("refuses a checksum mismatch and leaves nothing behind", async () => {
		const r = await install(one("0.20.0", { badSum: true }));
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("checksum mismatch");
		expect(installed()).toBeNull();
	});

	test("refuses a release without SHA256SUMS", async () => {
		const r = await install(one("0.20.0", { sums: false }));
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("unverified");
		expect(installed()).toBeNull();
	});

	test("refuses a binary that does not report the release's version", async () => {
		const r = await install(
			publish([{ tag: "v0.20.0", assets: { [ASSET]: fakeBinary("0.19.0") } }]),
		);
		expect(r.code).not.toBe(0);
		expect(installed()).toBeNull();
	});

	test("with a signing key: no .minisig is refused", async () => {
		const r = await install(one("0.20.0"), { EIGHT_TEST_SIGNING_KEY: "RWTESTKEY" });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("unsigned checksums");
	});

	test("with a signing key and minisign: a bad signature is refused, a good one installs", async () => {
		const url = one("0.20.0", { minisig: true });
		const log = join(root, "minisign.log");
		tool("minisign", `echo "$@" >> "${log}"; exit 1`);
		const bad = await install(url, { EIGHT_TEST_SIGNING_KEY: "RWTESTKEY" });
		expect(bad.code).not.toBe(0);
		expect(bad.out).toContain("valid release signature");
		expect(installed()).toBeNull();
		expect(readFileSync(log, "utf8")).toContain("-P RWTESTKEY");

		tool("minisign", "exit 0");
		const good = await install(url, { EIGHT_TEST_SIGNING_KEY: "RWTESTKEY" });
		expect(good.code).toBe(0);
		expect(good.out).toContain("signature on SHA256SUMS: verified");
	});

	const attJson = (ref: string) =>
		`[{"verificationResult":{"signature":{"certificate":{"sourceRepositoryRef":"${ref}"}}}}]`;

	test("gh attestation is pinned to release-binaries.yml and checks the release tag from JSON; a failure shows gh's message", async () => {
		const url = one("0.20.0");
		const log = join(root, "gh.log");
		tool(
			"gh",
			`echo "$@" >> "${log}"; case "$1 $2" in "auth status") exit 0 ;; "attestation verify") echo "boom: no matching attestation" >&2; exit 1 ;; esac; exit 2`,
		);
		const r = await install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("did not verify");
		expect(r.out).toContain("boom: no matching attestation");
		expect(installed()).toBeNull();
		const logged = readFileSync(log, "utf8");
		expect(logged).toContain(
			"--repo 8gi-foundation/8gent-code --signer-workflow 8gi-foundation/8gent-code/.github/workflows/release-binaries.yml --format json",
		);
		expect(logged).not.toContain("--source-ref");

		tool(
			"gh",
			`case "$1 $2" in "auth status") exit 0 ;; "attestation verify") echo '${attJson("refs/tags/v0.20.0")}'; exit 0 ;; esac; exit 2`,
		);
		const ok = await install(url);
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("attestation: verified");
	});

	test("an older gh that rejects --source-ref still installs, via JSON and the right ref", async () => {
		tool(
			"gh",
			`case "$1 $2" in "auth status") exit 0 ;; "attestation verify") case "$*" in *--source-ref*) echo "unknown flag: --source-ref" >&2; exit 1 ;; esac; echo '${attJson("refs/tags/v0.20.0")}'; exit 0 ;; esac; exit 2`,
		);
		const r = await install(one("0.20.0"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("attestation: verified");
		expect(installed()).not.toBeNull();
	});

	test("a verified attestation from a different ref is refused", async () => {
		tool(
			"gh",
			`case "$1 $2" in "auth status") exit 0 ;; "attestation verify") echo '${attJson("refs/heads/main")}'; exit 0 ;; esac; exit 2`,
		);
		const r = await install(one("0.20.0"));
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("refs/heads/main");
		expect(r.out).toContain("not refs/tags/v0.20.0");
		expect(installed()).toBeNull();
	});

	test("a gh too old for attestation says so plainly instead of reporting a failed verification", async () => {
		tool(
			"gh",
			'case "$1 $2" in "auth status") exit 0 ;; "attestation verify") echo "unknown command \\"attestation\\" for \\"gh\\"" >&2; exit 1 ;; esac; case "$1" in --version) echo "gh version 2.40.0"; exit 0 ;; esac; exit 2',
		);
		const r = await install(one("0.20.0"));
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("gh version 2.40.0");
		expect(r.out).toContain("brew upgrade gh");
		expect(r.out).not.toContain("did not verify");
		expect(installed()).toBeNull();
	});

	test("without a release key: installs on the checksum, with a warning", async () => {
		const r = await install(one("0.20.0"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("no signing key yet");
	});

	test("with a key and no verifier: refused unless EIGHT_ALLOW_UNVERIFIED=1", async () => {
		const url = one("0.20.0", { minisig: true });
		const env = { EIGHT_TEST_SIGNING_KEY: "RWTESTKEY", EIGHT_TEST_NO_VERIFIER: "1" };
		const strict = await install(url, env);
		expect(strict.code).not.toBe(0);
		expect(strict.out).toContain("EIGHT_ALLOW_UNVERIFIED=1");
		expect(installed()).toBeNull();
		const optOut = await install(url, { ...env, EIGHT_ALLOW_UNVERIFIED: "1" });
		expect(optOut.code).toBe(0);
		expect(optOut.out).toContain("was NOT checked");
	});

	describe("pinned verifier (no minisign on PATH)", () => {
		// The same archive layout as the real minisign 0.12 release for this OS.
		function verifierArchive(script: string): { path: string; sha: string; name: string } {
			const stage = join(root, "ms-stage");
			const linux = process.platform !== "darwin";
			const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
			const inner = linux ? join("minisign-linux", arch, "minisign") : "minisign";
			mkdirSync(join(stage, inner, ".."), { recursive: true });
			writeFileSync(join(stage, inner), `#!/bin/sh\n${script}\n`);
			chmodSync(join(stage, inner), 0o755);
			const name = linux ? "minisign-0.12-linux.tar.gz" : "minisign-0.12-macos.zip";
			const out = join(root, name);
			const r = linux
				? Bun.spawnSync(["tar", "-czf", out, "-C", stage, "minisign-linux"])
				: Bun.spawnSync(["zip", "-q", out, "minisign"], { cwd: stage });
			if (r.exitCode !== 0) throw new Error(r.stderr.toString());
			const bytes = readFileSync(out);
			return { path: out, sha: createHash("sha256").update(bytes).digest("hex"), name };
		}

		test("downloads it, checks its SHA256, then verifies with it", async () => {
			const url = one("0.20.0", { minisig: true });
			const log = join(root, "pinned.log");
			const a = verifierArchive(`echo "$@" >> "${log}"; exit 0`);
			routes.set(`/verifier/${a.name}`, { body: readFileSync(a.path) });
			const r = await install(url, {
				EIGHT_TEST_SIGNING_KEY: "RWTESTKEY",
				EIGHT_TEST_MINISIGN_URL: `${base}/verifier/${a.name}`,
				EIGHT_TEST_MINISIGN_SHA256: a.sha,
			});
			expect(r.out).toContain("pinned signature verifier");
			expect(r.code).toBe(0);
			expect(r.out).toContain("signature on SHA256SUMS: verified");
			expect(readFileSync(log, "utf8")).toContain("-P RWTESTKEY");
		});

		test("a verifier whose SHA256 does not match the pin is never run", async () => {
			const url = one("0.20.0", { minisig: true });
			const log = join(root, "pinned.log");
			const a = verifierArchive(`echo ran >> "${log}"; exit 0`);
			routes.set(`/verifier/${a.name}`, { body: readFileSync(a.path) });
			const r = await install(url, {
				EIGHT_TEST_SIGNING_KEY: "RWTESTKEY",
				EIGHT_TEST_MINISIGN_URL: `${base}/verifier/${a.name}`,
				EIGHT_TEST_MINISIGN_SHA256: "0".repeat(64),
			});
			expect(r.code).not.toBe(0);
			expect(r.out).toContain("pinned SHA256");
			expect(existsSync(log)).toBe(false);
			expect(installed()).toBeNull();
		});
	});

	const wget = Bun.which("wget");
	test.skipIf(!wget)("the wget fallback checks every redirect hop too", async () => {
		symlinkSync(wget as string, join(fakeBin, "wget"));
		let url = one("0.20.0");
		const real = routes.get(`/releases/download/v0.20.0/${ASSET}`);
		routes.set(`/releases/download/v0.20.0/${ASSET}`, { location: `${base}/cdn/blob` });
		routes.set("/cdn/blob", real ?? {});
		const ok = await install(url, { EIGHT_TEST_FORCE_WGET: "1" });
		expect(ok.out).toContain("Installed 8gent v0.20.0");
		expect(ok.code).toBe(0);

		rmSync(installDir, { recursive: true, force: true });
		url = one("0.20.0");
		routes.set(`/releases/download/v0.20.0/${ASSET}`, { location: "http://evil.example/blob" });
		const bad = await install(url, { EIGHT_TEST_FORCE_WGET: "1" });
		expect(bad.code).not.toBe(0);
		expect(bad.out).toContain("refusing a redirect");
		expect(installed()).toBeNull();
	});
});

describe("install.sh: replacing an existing install", () => {
	test("never replaces a newer installed 8gent with an older release", async () => {
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "8gent"), fakeBinary("0.30.0"));
		chmodSync(join(installDir, "8gent"), 0o755);
		const r = await install(one("0.20.0"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("Nothing changed");
		expect(installed()).toBe("8gent Code v0.30.0");
	});

	test("upgrades an older install in place and leaves no staging file", async () => {
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "8gent"), fakeBinary("0.17.0"));
		chmodSync(join(installDir, "8gent"), 0o755);
		expect((await install(one("0.20.0"))).code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
		expect(Bun.spawnSync(["ls", "-A", installDir]).stdout.toString().trim()).toBe("8gent");
	});

	test("warns, with the fix, when another 8gent comes first on PATH", async () => {
		tool("8gent", 'echo "8gent Code v0.17.0"');
		const r = await install(one("0.20.0"), {
			PATH: `${fakeBin}:${installDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain(`on your PATH is ${join(fakeBin, "8gent")}`);
		expect(r.out).toContain("npm uninstall -g");
	});
});

test("the embedded signing keys match scripts/release-signing.pub", () => {
	const pub = readFileSync(join(import.meta.dir, "..", "release-signing.pub"), "utf8")
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"))
		.join("")
		.trim();
	const sh = /^EIGHT_SIGNING_KEY="([^"]*)"$/m.exec(readFileSync(SCRIPT, "utf8"))?.[1];
	const ps = /^\$EightSigningKey = '([^']*)'$/m.exec(
		readFileSync(join(import.meta.dir, "..", "install.ps1"), "utf8"),
	)?.[1];
	expect(sh).toBe(pub);
	expect(ps).toBe(pub);
});

test("install.sh is wrapped in main and calls it on the last line", () => {
	const lines = readFileSync(SCRIPT, "utf8").trimEnd().split("\n");
	expect(lines[lines.length - 1]).toBe('main "$@"');
});

// (b4) Interop with the real minisign: a key made and a signature written by
// the real binary, verified by install.sh both with minisign on PATH and
// through the pinned-verifier download path. MINISIGN_BIN or PATH supplies
// it (release-install-smoke.yml provides the pinned 0.12 build).
const realMinisign = process.env.MINISIGN_BIN || Bun.which("minisign");
describe.skipIf(!realMinisign)("install.sh with the real minisign", () => {
	const ms = realMinisign as string;
	function keypair(): string {
		const r = Bun.spawnSync([
			ms,
			"-G",
			"-W",
			"-f",
			"-p",
			join(root, "k.pub"),
			"-s",
			join(root, "k.key"),
		]);
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
		return readFileSync(join(root, "k.pub"), "utf8").split("\n")[1].trim();
	}
	/** Sign the served SHA256SUMS of v0.20.0 with the real binary; optionally tamper after. */
	function signServed(tamper = false) {
		const path = "/releases/download/v0.20.0/SHA256SUMS";
		const sums = String(routes.get(path)?.body ?? "");
		writeFileSync(join(root, "SHA256SUMS"), sums);
		const r = Bun.spawnSync(
			[
				ms,
				"-S",
				"-s",
				join(root, "k.key"),
				"-m",
				join(root, "SHA256SUMS"),
				"-x",
				join(root, "s.minisig"),
			],
			{ stdin: "ignore" },
		);
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
		routes.set("/releases/download/v0.20.0/SHA256SUMS.minisig", {
			body: readFileSync(join(root, "s.minisig"), "utf8"),
		});
		if (tamper) routes.set(path, { body: `${sums}${"b".repeat(64)}  extra\n` });
	}

	test("a real signature verifies with minisign on PATH; a tampered SHA256SUMS is refused", async () => {
		const key = keypair();
		symlinkSync(ms, join(fakeBin, "minisign"));
		const url = one("0.20.0", { minisig: true });
		signServed();
		const ok = await install(url, { EIGHT_TEST_SIGNING_KEY: key });
		expect(ok.out).toContain("signature on SHA256SUMS: verified");
		expect(ok.code).toBe(0);

		rmSync(installDir, { recursive: true, force: true });
		const url2 = one("0.20.0", { minisig: true });
		signServed(true);
		const bad = await install(url2, { EIGHT_TEST_SIGNING_KEY: key });
		expect(bad.code).not.toBe(0);
		expect(bad.out).toContain("valid release signature");
		expect(installed()).toBeNull();
	});

	test("a real signature verifies through the pinned-verifier download path", async () => {
		const key = keypair();
		const url = one("0.20.0", { minisig: true });
		signServed();
		const linux = process.platform !== "darwin";
		const stage = join(root, "ms-real");
		const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
		const inner = linux ? join("minisign-linux", arch, "minisign") : "minisign";
		mkdirSync(join(stage, inner, ".."), { recursive: true });
		writeFileSync(join(stage, inner), readFileSync(ms));
		chmodSync(join(stage, inner), 0o755);
		const name = linux ? "minisign-0.12-linux.tar.gz" : "minisign-0.12-macos.zip";
		const archive = join(root, name);
		const z = linux
			? Bun.spawnSync(["tar", "-czf", archive, "-C", stage, "minisign-linux"])
			: Bun.spawnSync(["zip", "-q", archive, "minisign"], { cwd: stage });
		expect(z.exitCode).toBe(0);
		const bytes = readFileSync(archive);
		routes.set(`/verifier/${name}`, { body: bytes });
		const r = await install(url, {
			EIGHT_TEST_SIGNING_KEY: key,
			EIGHT_TEST_MINISIGN_URL: `${base}/verifier/${name}`,
			EIGHT_TEST_MINISIGN_SHA256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(r.out).toContain("pinned signature verifier");
		expect(r.out).toContain("signature on SHA256SUMS: verified");
		expect(r.code).toBe(0);
	});
});

describe("install.sh: Android / Termux", () => {
	/** A uname that answers like Termux on arm64 (kernel Linux, OS Android). */
	const termuxUname = () =>
		tool(
			"uname",
			`case "$1" in -s) echo Linux;; -m) echo aarch64;; -o) echo Android;; -a) echo "Linux localhost 5.15.0 #1 SMP PREEMPT Android aarch64 Android";; *) echo Linux;; esac`,
		);
	const termuxEnv = { PREFIX: "/data/data/com.termux/files/usr", TERMUX_VERSION: "0.118" };

	test("names Android, stops before any download, and says what to do", async () => {
		termuxUname();
		const url = one("0.20.0");
		hits = 0;
		const r = await install(url, termuxEnv);
		expect(r.code).toBe(1);
		expect(r.out).toContain("Android (Termux)");
		expect(r.out).toContain("proot-distro");
		expect(r.out).toContain("Nothing was installed");
		expect(installed()).toBeNull();
	});

	test("--dry-run prints the decisions: android, bionic, linux-arm64, Termux prefix, no sudo", async () => {
		termuxUname();
		const r = await install(one("0.20.0"), { ...termuxEnv, EIGHT_INSTALL_DIR: "" }, ["--dry-run"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("a real run would stop here");
		expect(r.out).toContain("uname -s/-m/-o : Linux / aarch64 / Android");
		expect(r.out).toContain("android         : yes");
		expect(r.out).toContain("libc            : bionic");
		expect(r.out).toContain("asset           : 8gent-linux-arm64");
		expect(r.out).toContain("install dir     : /data/data/com.termux/files/usr/bin");
		expect(r.out).not.toContain("sudo");
	});

	test("EIGHT_INSTALL_DEBUG=1 with EIGHT_ANDROID_FORCE=1 prints decisions and installs", async () => {
		termuxUname();
		const url = publish([
			{ tag: "v0.20.0", assets: { "8gent-linux-arm64": fakeBinary("0.20.0") } },
		]);
		const r = await install(url, {
			...termuxEnv,
			EIGHT_INSTALL_DEBUG: "1",
			EIGHT_ANDROID_FORCE: "1",
			EIGHT_INSTALL_DIR: installDir,
		});
		expect(r.out).toContain("libc            : bionic");
		expect(r.code).toBe(0);
		expect(installed()).toBe("8gent Code v0.20.0");
	});

	test("detects Android from TERMUX_VERSION alone when uname says plain Linux", async () => {
		tool(
			"uname",
			`case "$1" in -s) echo Linux;; -m) echo aarch64;; -o) echo GNU/Linux;; *) echo Linux;; esac`,
		);
		const r = await install(one("0.20.0"), { TERMUX_VERSION: "0.118" }, ["--dry-run"]);
		expect(r.out).toContain("android         : yes");
	});

	test("a normal glibc Linux arm64 box is not treated as Android", async () => {
		tool(
			"uname",
			`case "$1" in -s) echo Linux;; -m) echo aarch64;; -o) echo GNU/Linux;; -a) echo "Linux box 6.1 aarch64 GNU/Linux";; *) echo Linux;; esac`,
		);
		const r = await install(one("0.20.0"), {}, ["--dry-run"]);
		expect(r.out).toContain("android         : no");
		expect(r.out).toContain("asset           : 8gent-linux-arm64");
		expect(r.code).toBe(0);
	});

	const unameFor = (m: string, o: string, host = "box") =>
		tool(
			"uname",
			`case "$1" in -s) echo Linux;; -m) echo ${m};; -o) echo ${o};; -a) echo "Linux ${host} 6.1 ${m} ${o}";; *) echo Linux;; esac`,
		);

	test("a hostname containing android on plain Linux is not Android", async () => {
		unameFor("x86_64", "GNU/Linux", "android-ci-01");
		const r = await install(one("0.20.0"), {}, ["--dry-run"]);
		expect(r.out).toContain("android         : no");
		expect(r.code).toBe(0);
	});

	test("armv8l off Android dies cleanly", async () => {
		unameFor("armv8l", "GNU/Linux");
		const r = await install(one("0.20.0"), {}, ["--dry-run"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("no 8gent binary for armv8l");
	});

	test("armv8l on Android maps to arm64", async () => {
		unameFor("armv8l", "Android");
		const r = await install(one("0.20.0"), { EIGHT_INSTALL_DIR: "" }, ["--dry-run"]);
		expect(r.out).toContain("asset           : 8gent-linux-arm64");
	});

	test("the debug echo strips userinfo from the releases URL", async () => {
		const r = await install("https://user:secret@example.invalid/r.json", {}, ["--dry-run"]);
		expect(r.out).toContain("releases url");
		expect(r.out).not.toContain("secret");
	});

	test("the force path warns it will fail without glibc", async () => {
		unameFor("aarch64", "Android");
		const r = await install(one("0.20.0"), { EIGHT_ANDROID_FORCE: "1" }, ["--dry-run"]);
		expect(r.out).toContain("will fail unless this box runs glibc binaries");
	});

	test("the debug echo hides the query string of the releases URL", async () => {
		const r = await install("https://example.invalid/r.json?token=abc123", {}, ["--dry-run"]);
		expect(r.out).toContain("r.json?...");
		expect(r.out).not.toContain("abc123");
	});
});
