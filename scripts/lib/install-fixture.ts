#!/usr/bin/env bun
/**
 * Builds a fake 8gent release site for the install smoke workflow
 * (.github/workflows/release-install-smoke.yml), so scripts/install.sh and
 * scripts/install.ps1 run end to end on real Windows, macOS and Linux runners
 * without a published release.
 *
 *   bun scripts/lib/install-fixture.ts <dir> <base-url>
 *
 * Writes into <dir>:
 *   releases/download/v0.0.1/<asset> + SHA256SUMS   a compiled "8gent" printing v0.0.1
 *   releases/download/v0.0.2/<asset> + SHA256SUMS   the same, printing v0.0.2
 *   releases/download/v0.0.4/<asset> + SHA256SUMS   printing v0.0.4, published as a PRERELEASE
 *   releases.json      v0.0.4 (prerelease), v0.0.3 (no assets), v0.0.2, v0.0.1
 *   releases-old.json  v0.0.1 only (an install from here must not downgrade v0.0.2)
 *   releases-evil.json v0.0.5 whose binary URL points off 127.0.0.1 (must be refused)
 *   install.sh, install-ps1.txt   copies, so the literal one-liners are tested
 *                                 (.txt so the test server sends text/plain, as GitHub raw does)
 * <asset> is this host's release asset name, as scripts/build-binaries.ts names it.
 *
 * With FIXTURE_MINISIGN=<path to a real minisign>, every SHA256SUMS is signed
 * with a throwaway key made by that binary and served with its .minisig; the
 * public key is written to signing-key.txt, and releases-badsig.json offers
 * v0.0.7 whose SHA256SUMS was changed after signing (must be refused).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeBunFlags } from "../../packages/core/bun-flags";

const [dir, base] = process.argv.slice(2);
if (!dir || !base) {
	console.error("usage: install-fixture.ts <dir> <base-url>");
	process.exit(2);
}

function hostAsset(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "win32") return "8gent-windows-x64.exe";
	if (process.platform === "darwin") return `8gent-darwin-${arch}`;
	return `8gent-linux-${arch}`;
}

const asset = hostAsset();
const versions = ["0.0.1", "0.0.2", "0.0.4"];
mkdirSync(dir, { recursive: true });

for (const v of versions) {
	const out = join(dir, "releases", "download", `v${v}`);
	mkdirSync(out, { recursive: true });
	const src = join(dir, `fake-${v}.ts`);
	writeFileSync(src, `console.log("8gent Code v${v}");\n`);
	// No cwd bunfig.toml or .env, and no auto-install (#4013).
	const r = spawnSync("bun", [...safeBunFlags(), "--no-install", "build", "--compile", src, "--outfile", join(out, asset)], {
		stdio: "inherit",
	});
	if (r.status !== 0) process.exit(r.status ?? 1);
	const sum = createHash("sha256")
		.update(readFileSync(join(out, asset)))
		.digest("hex");
	writeFileSync(join(out, "SHA256SUMS"), `${sum}  ${asset}\n`);
}

// GitHub's key order: tag_name, draft, prerelease, then assets.
const minisign = process.env.FIXTURE_MINISIGN;
function ms(args: string[]) {
	const r = spawnSync(minisign as string, args, { stdio: ["ignore", "inherit", "inherit"] });
	if (r.status !== 0) process.exit(r.status ?? 1);
}
// v0.0.7: v0.0.2's binary, SHA256SUMS signed and then changed.
mkdirSync(join(dir, "releases", "download", "v0.0.7"), { recursive: true });
copyFileSync(
	join(dir, "releases", "download", "v0.0.2", asset),
	join(dir, "releases", "download", "v0.0.7", asset),
);
copyFileSync(
	join(dir, "releases", "download", "v0.0.2", "SHA256SUMS"),
	join(dir, "releases", "download", "v0.0.7", "SHA256SUMS"),
);
// v0.0.5's SHA256SUMS is served, so only the off-host binary URL can stop it.
mkdirSync(join(dir, "releases", "download", "v0.0.5"), { recursive: true });
copyFileSync(
	join(dir, "releases", "download", "v0.0.2", "SHA256SUMS"),
	join(dir, "releases", "download", "v0.0.5", "SHA256SUMS"),
);
if (minisign) {
	ms(["-G", "-W", "-f", "-p", join(dir, "signing.pub"), "-s", join(dir, "signing.key")]);
	writeFileSync(
		join(dir, "signing-key.txt"),
		readFileSync(join(dir, "signing.pub"), "utf8").split(/\r?\n/)[1].trim(),
	);
	for (const v of [...versions, "0.0.5", "0.0.7"]) {
		const sums = join(dir, "releases", "download", `v${v}`, "SHA256SUMS");
		ms(["-S", "-s", join(dir, "signing.key"), "-m", sums, "-x", `${sums}.minisig`]);
	}
	writeFileSync(
		join(dir, "releases", "download", "v0.0.7", "SHA256SUMS"),
		`${readFileSync(join(dir, "releases", "download", "v0.0.7", "SHA256SUMS"), "utf8")}${"b".repeat(64)}  extra\n`,
	);
}
const files = minisign ? [asset, "SHA256SUMS", "SHA256SUMS.minisig"] : [asset, "SHA256SUMS"];

const release = (v: string, withAssets: boolean, prerelease = false, assetBase = base) => ({
	tag_name: `v${v}`,
	draft: false,
	prerelease,
	assets: withAssets
		? files.map((name) => ({
				name,
				browser_download_url: `${name === asset ? assetBase : base}/releases/download/v${v}/${name}`,
			}))
		: [],
});

writeFileSync(
	join(dir, "releases.json"),
	JSON.stringify(
		[
			release("0.0.4", true, true),
			release("0.0.3", false),
			release("0.0.2", true),
			release("0.0.1", true),
		],
		null,
		2,
	),
);
writeFileSync(join(dir, "releases-old.json"), JSON.stringify([release("0.0.1", true)], null, 2));
writeFileSync(join(dir, "releases-badsig.json"), JSON.stringify([release("0.0.7", true)], null, 2));
writeFileSync(
	join(dir, "releases-evil.json"),
	JSON.stringify([release("0.0.5", true, false, "http://example.com")], null, 2),
);
copyFileSync(join(import.meta.dir, "..", "install.sh"), join(dir, "install.sh"));
copyFileSync(join(import.meta.dir, "..", "install.ps1"), join(dir, "install-ps1.txt"));
console.log(`fixture for ${asset} in ${dir}`);
