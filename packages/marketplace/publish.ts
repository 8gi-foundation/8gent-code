/**
 * 8gent App Marketplace - Publish orchestration
 *
 * High-level pipeline that runs every step of `8gent publish`:
 *   manifest -> lint -> capability audit -> stage -> integrity ->
 *   tar -> size check -> round-trip verify.
 *
 * Returns a structured result instead of side-effecting, so the CLI
 * can decide on exit codes and the control plane can reuse the same
 * pipeline server-side.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	ARCHIVE_SUFFIX,
	auditArchiveEntries,
	buildArchive,
	extractArchive,
	stageAppDirectory,
} from "./archive";
import {
	auditCapabilities,
	checkSize,
	DEFAULT_MAX_BYTES,
	dirSize,
	lintSource,
	type CheckResult,
} from "./checks";
import { verifyIntegrity, writeIntegrity } from "./integrity";
import {
	type AppManifest,
	type ManifestValidationResult,
	validateManifest,
} from "./manifest";

export type PublishExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export interface PublishOptions {
	/** Directory containing the app (must hold manifest.json + src/). */
	appDir: string;
	/** Output archive path. Defaults to `<name>-<version>.8gent-app.tar.gz`. */
	outPath?: string;
	/** Override the default 10 MiB size cap. */
	maxBytes?: number;
	/** Permit archives that declare the `dangerous` capability. */
	allowDangerous?: boolean;
	/** Treat lint warnings as errors. */
	strictLint?: boolean;
	/** Where staging temp dirs go. Defaults to OS tmp. */
	tmpDir?: string;
}

export interface PublishResult {
	ok: boolean;
	exitCode: PublishExitCode;
	manifest?: AppManifest;
	archivePath?: string;
	checks: CheckResult[];
	errors: string[];
}

function mkdtemp(prefix: string, base?: string): string {
	const root = base ?? os.tmpdir();
	return fs.mkdtempSync(path.join(root, prefix));
}

function readManifest(appDir: string): ManifestValidationResult {
	const manifestPath = path.join(appDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		return { ok: false, errors: [`manifest.json missing in ${appDir}`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch (err) {
		return { ok: false, errors: [`manifest.json is not valid JSON: ${err}`] };
	}
	return validateManifest(parsed);
}

/**
 * Run the full publish pipeline. Never throws; the CLI can use
 * `result.exitCode` directly.
 */
export async function runPublish(options: PublishOptions): Promise<PublishResult> {
	const checks: CheckResult[] = [];
	const errors: string[] = [];

	if (!fs.existsSync(options.appDir) || !fs.statSync(options.appDir).isDirectory()) {
		return {
			ok: false,
			exitCode: 1,
			checks,
			errors: [`app directory not found: ${options.appDir}`],
		};
	}

	const manifestRes = readManifest(options.appDir);
	if (!manifestRes.ok || !manifestRes.manifest) {
		return {
			ok: false,
			exitCode: 1,
			checks,
			errors: ["manifest validation failed", ...manifestRes.errors],
		};
	}
	const manifest = manifestRes.manifest;
	checks.push({
		name: "manifest",
		level: "ok",
		message: `${manifest.name}@${manifest.version}`,
	});

	const cap = auditCapabilities(manifest, { allowDangerous: options.allowDangerous });
	checks.push(cap);
	if (cap.level === "error") {
		return { ok: false, exitCode: 2, manifest, checks, errors: [cap.message] };
	}

	const srcDir = path.join(options.appDir, "src");
	const lint = lintSource(srcDir, { strict: options.strictLint });
	checks.push(lint);
	if (lint.level === "error") {
		return { ok: false, exitCode: 1, manifest, checks, errors: [lint.message] };
	}

	const sizeBefore = dirSize(options.appDir);
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (sizeBefore > maxBytes) {
		const msg = `app directory is ${sizeBefore} bytes; exceeds limit of ${maxBytes}`;
		checks.push({ name: "size-pre", level: "error", message: msg });
		return { ok: false, exitCode: 3, manifest, checks, errors: [msg] };
	}

	const rootName = `${manifest.name}-${manifest.version}`;
	const stagingDir = mkdtemp("8gent-publish-", options.tmpDir);
	const stagedTree = stageAppDirectory({
		source: options.appDir,
		stagingDir,
		rootName,
	});

	try {
		writeIntegrity(stagedTree);

		const outPath =
			options.outPath ?? path.resolve(process.cwd(), `${rootName}${ARCHIVE_SUFFIX}`);

		try {
			buildArchive({ stagingDir, rootName, outPath });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			checks.push({ name: "tar", level: "error", message: msg });
			return { ok: false, exitCode: 5, manifest, checks, errors: [msg] };
		}

		const sizeRes = checkSize(outPath, { maxBytes });
		checks.push(sizeRes);
		if (sizeRes.level === "error") {
			fs.rmSync(outPath, { force: true });
			return { ok: false, exitCode: 3, manifest, checks, errors: [sizeRes.message] };
		}

		const entryAudit = auditArchiveEntries(outPath, rootName);
		if (!entryAudit.ok) {
			checks.push({
				name: "archive-entries",
				level: "error",
				message: entryAudit.errors.join("; "),
			});
			fs.rmSync(outPath, { force: true });
			return { ok: false, exitCode: 4, manifest, checks, errors: entryAudit.errors };
		}
		checks.push({ name: "archive-entries", level: "ok", message: "no escaping paths" });

		const verifyDir = mkdtemp("8gent-verify-", options.tmpDir);
		try {
			extractArchive(outPath, verifyDir);
			const verifyRoot = path.join(verifyDir, rootName);
			const verify = verifyIntegrity(verifyRoot);
			if (!verify.ok) {
				checks.push({
					name: "integrity-roundtrip",
					level: "error",
					message: verify.errors.join("; "),
				});
				fs.rmSync(outPath, { force: true });
				return { ok: false, exitCode: 4, manifest, checks, errors: verify.errors };
			}
			checks.push({ name: "integrity-roundtrip", level: "ok", message: "passed" });
		} finally {
			fs.rmSync(verifyDir, { recursive: true, force: true });
		}

		return {
			ok: true,
			exitCode: 0,
			manifest,
			archivePath: outPath,
			checks,
			errors,
		};
	} finally {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
}
