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
 *   releases.json      v0.0.3 (no assets, the 1 Oct shape), v0.0.2, v0.0.1
 *   releases-old.json  v0.0.1 only (an install from here must not downgrade v0.0.2)
 *   install.sh, install-ps1.txt   copies, so the literal one-liners are tested
 *                                 (.txt so the test server sends text/plain, as GitHub raw does)
 * <asset> is this host's release asset name, as scripts/build-binaries.ts names it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const versions = ["0.0.1", "0.0.2"];
mkdirSync(dir, { recursive: true });

for (const v of versions) {
	const out = join(dir, "releases", "download", `v${v}`);
	mkdirSync(out, { recursive: true });
	const src = join(dir, `fake-${v}.ts`);
	writeFileSync(src, `console.log("8gent Code v${v}");\n`);
	const r = spawnSync("bun", ["build", "--compile", src, "--outfile", join(out, asset)], {
		stdio: "inherit",
	});
	if (r.status !== 0) process.exit(r.status ?? 1);
	const sum = createHash("sha256")
		.update(readFileSync(join(out, asset)))
		.digest("hex");
	writeFileSync(join(out, "SHA256SUMS"), `${sum}  ${asset}\n`);
}

const release = (v: string, withAssets: boolean) => ({
	tag_name: `v${v}`,
	draft: false,
	prerelease: false,
	assets: withAssets
		? [asset, "SHA256SUMS"].map((name) => ({
				name,
				browser_download_url: `${base}/releases/download/v${v}/${name}`,
			}))
		: [],
});

writeFileSync(
	join(dir, "releases.json"),
	JSON.stringify(
		[release("0.0.3", false), release("0.0.2", true), release("0.0.1", true)],
		null,
		2,
	),
);
writeFileSync(join(dir, "releases-old.json"), JSON.stringify([release("0.0.1", true)], null, 2));
copyFileSync(join(import.meta.dir, "..", "install.sh"), join(dir, "install.sh"));
copyFileSync(join(import.meta.dir, "..", "install.ps1"), join(dir, "install-ps1.txt"));
console.log(`fixture for ${asset} in ${dir}`);
