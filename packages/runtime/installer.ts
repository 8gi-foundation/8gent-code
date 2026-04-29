/**
 * @8gent/runtime — installer.ts
 *
 * Downloads a Node binary from nodejs.org and extracts it to
 * `~/.8gent/runtime/node-<version>/`. Idempotent: if the runtime
 * is already ready, returns `already-ready` without touching the
 * filesystem.
 *
 * Strategy:
 *   1. Plan: compute URL + paths from version + platform + arch.
 *   2. Probe: if the binary already exists AND `--version` reports
 *      >= the required version, return `already-ready`.
 *   3. Download: stream the tarball/zip to a temp file under the
 *      runtime root.
 *   4. Extract: shell out to `tar` (tar.gz/tar.xz) or `unzip` (zip).
 *      Extracted dir is renamed/moved to the canonical location.
 *   5. Verify: re-probe and bail with a clean error if it didn't
 *      come up. Cleanup the temp archive.
 *
 * No native deps. No JS tar/zip libs. macOS/Linux ship `tar`; Windows
 * ships `tar` (since Win10 1803) and `expand-archive` for zip.
 */

import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	type Arch,
	buildDownloadUrl,
	getRuntimeDir,
	isRuntimeReady,
	type PlatformAsset,
	pickPlatformAsset,
	resolvedNodeBinPath,
} from "./node-runtime.js";

// ============================================================================
// Plan (pure)
// ============================================================================

export interface InstallPlan {
	version: string;
	url: string;
	asset: PlatformAsset;
	runtimeDir: string;
	binPath: string;
	archiveExt: PlatformAsset["ext"];
}

export interface InstallInput {
	version: string;
	root?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	dryRun?: boolean;
	/** Override the minimum acceptable version (defaults to `version`). */
	minVersion?: string;
}

export function planInstall(input: InstallInput): InstallPlan {
	const platform = input.platform ?? (process.platform as NodeJS.Platform);
	const arch = input.arch ?? process.arch;
	const asset = pickPlatformAsset({ platform, arch });
	const url = buildDownloadUrl({ version: input.version, asset });
	const runtimeDir = getRuntimeDir({ root: input.root, version: input.version });
	const binPath = resolvedNodeBinPath({
		root: input.root,
		version: input.version,
		platform,
	});
	return {
		version: input.version,
		url,
		asset,
		runtimeDir,
		binPath,
		archiveExt: asset.ext,
	};
}

// ============================================================================
// Install (impure)
// ============================================================================

export interface InstallResult extends InstallPlan {
	action: "already-ready" | "installed" | "dry-run" | "failed";
	error?: string;
}

export async function installRuntime(input: InstallInput): Promise<InstallResult> {
	const plan = planInstall(input);
	const platform = input.platform ?? (process.platform as NodeJS.Platform);
	const minVersion = input.minVersion ?? input.version;

	// Probe first — skip work if the runtime is already ready.
	const ready = await isRuntimeReady({
		root: input.root,
		version: input.version,
		platform,
		minVersion,
	});

	if (ready || input.dryRun) {
		return {
			...plan,
			action: ready ? "already-ready" : "dry-run",
		};
	}

	// Make sure the runtime root exists.
	const runtimeRoot = plan.runtimeDir.replace(/\/node-[^/]+$/, "");
	mkdirSync(runtimeRoot, { recursive: true });

	// Download into a sibling temp dir so a partial download never
	// pollutes the canonical runtime path.
	const stagingDir = mkdtempSync(join(runtimeRoot, ".dl-"));
	const archivePath = join(stagingDir, `node.${plan.archiveExt}`);

	try {
		await downloadFile(plan.url, archivePath);
		const extractRoot = join(stagingDir, "extract");
		mkdirSync(extractRoot, { recursive: true });
		await extractArchive(archivePath, extractRoot, plan.archiveExt);

		// nodejs.org tarballs unpack to a directory like
		// `node-v22.12.0-darwin-arm64/`. Find that single child and
		// move it to the canonical name.
		const children = readdirSync(extractRoot);
		const nodeDir = children.find((n) => n.startsWith("node-"));
		if (!nodeDir) {
			throw new Error(`could not find node-* dir inside ${extractRoot}`);
		}
		const extractedPath = join(extractRoot, nodeDir);

		// Move into place. If something already exists at the canonical
		// path, blow it away first (probably a half-finished install).
		if (existsSync(plan.runtimeDir)) {
			rmSync(plan.runtimeDir, { recursive: true, force: true });
		}
		renameSync(extractedPath, plan.runtimeDir);
	} catch (err) {
		return {
			...plan,
			action: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		// Best-effort cleanup of the staging dir.
		try {
			rmSync(stagingDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	// Re-probe. If the binary doesn't satisfy minVersion the install
	// silently succeeded but produced an unusable runtime — surface it.
	const reReady = await isRuntimeReady({
		root: input.root,
		version: input.version,
		platform,
		minVersion,
	});
	if (!reReady) {
		return {
			...plan,
			action: "failed",
			error: `installed runtime at ${plan.binPath} but it does not satisfy minVersion ${minVersion}`,
		};
	}

	return {
		...plan,
		action: "installed",
	};
}

// ============================================================================
// Download + extract helpers
// ============================================================================

async function downloadFile(url: string, dest: string): Promise<void> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) {
		throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
	}
	const out = createWriteStream(dest);
	// Node's fetch returns a web ReadableStream; pipe via stream/promises.
	await pipeline(Readable.fromWeb(res.body as never), out);
}

async function extractArchive(
	archivePath: string,
	destDir: string,
	ext: PlatformAsset["ext"],
): Promise<void> {
	if (ext === "tar.gz" || ext === "tar.xz") {
		// `tar` ships on macOS/Linux/Windows-since-1803 and handles both formats.
		await runCmd("tar", ["-xf", archivePath, "-C", destDir]);
	} else if (ext === "zip") {
		// Use `tar -xf` for zip on Windows (works since 1803), fall back
		// to PowerShell Expand-Archive otherwise.
		try {
			await runCmd("tar", ["-xf", archivePath, "-C", destDir]);
		} catch {
			await runCmd("powershell", [
				"-Command",
				`Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
			]);
		}
	} else {
		throw new Error(`unsupported archive ext: ${ext}`);
	}
}

function runCmd(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: "ignore" });
		proc.on("error", (err) => reject(err));
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
		});
	});
}

// Final unused-export guard — remove if Bun's tree-shaker complains.
export type { Arch, PlatformAsset };
