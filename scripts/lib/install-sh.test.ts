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
let routes = new Map<string, { body?: string; location?: string }>();
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const r = routes.get(new URL(req.url).pathname);
			if (!r) return new Response("not found", { status: 404 });
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

async function install(releasesUrl: string, env: Record<string, string> = {}) {
	const p = Bun.spawn(["sh", SCRIPT], {
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

	test("a signed-in gh whose attestation fails stops the install", async () => {
		const url = one("0.20.0");
		tool(
			"gh",
			'case "$1 $2" in "auth status") exit 0 ;; "attestation verify") exit 1 ;; esac; exit 2',
		);
		const r = await install(url);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("attestation");
		expect(installed()).toBeNull();

		tool(
			"gh",
			'case "$1 $2" in "auth status") exit 0 ;; "attestation verify") exit 0 ;; esac; exit 2',
		);
		const ok = await install(url);
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("attestation: verified");
	});

	test("EIGHT_REQUIRE_VERIFIED=1 refuses when nothing could verify; otherwise it warns", async () => {
		const url = one("0.20.0");
		const strict = await install(url, { EIGHT_REQUIRE_VERIFIED: "1" });
		expect(strict.code).not.toBe(0);
		expect(installed()).toBeNull();
		const relaxed = await install(url);
		expect(relaxed.code).toBe(0);
		expect(relaxed.out).toContain("only the SHA256 checksum was checked");
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
