/**
 * 8gent App Marketplace - Pre-submission checks
 *
 * Lint, capability audit, and size limit gates that run before an
 * archive is uploaded. Each check returns a structured result so the
 * CLI can decide whether to fail (and with what exit code).
 *
 * See docs/specs/APP-ARCHIVE-FORMAT.md Section 4.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AppManifest } from "./manifest";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface CheckResult {
	name: string;
	level: "ok" | "warn" | "error";
	message: string;
}

export interface CapabilityAuditOptions {
	allowDangerous?: boolean;
}

/**
 * Reject `dangerous` capability without an explicit override flag.
 */
export function auditCapabilities(
	manifest: AppManifest,
	options: CapabilityAuditOptions = {},
): CheckResult {
	const hasDangerous = manifest.capabilities.includes("dangerous");
	if (!hasDangerous) {
		return {
			name: "capability-audit",
			level: "ok",
			message: `${manifest.capabilities.length} capabilities declared`,
		};
	}
	if (options.allowDangerous) {
		return {
			name: "capability-audit",
			level: "warn",
			message: "dangerous capability declared with --allow-dangerous override",
		};
	}
	return {
		name: "capability-audit",
		level: "error",
		message: "manifest declares 'dangerous' capability; manual review required (use --allow-dangerous)",
	};
}

/**
 * Run `biome check` against the source dir if biome is available.
 * Lint failures are warnings unless `strict` is true.
 */
export function lintSource(srcDir: string, options: { strict?: boolean } = {}): CheckResult {
	if (!fs.existsSync(srcDir)) {
		return { name: "lint", level: "warn", message: `no src/ directory at ${srcDir}` };
	}
	const probe = spawnSync("biome", ["--version"], { encoding: "utf-8" });
	if (probe.status !== 0) {
		return { name: "lint", level: "warn", message: "biome not on PATH; skipped" };
	}
	const result = spawnSync("biome", ["check", srcDir], { encoding: "utf-8" });
	if (result.status === 0) {
		return { name: "lint", level: "ok", message: "biome check passed" };
	}
	return {
		name: "lint",
		level: options.strict ? "error" : "warn",
		message: `biome check reported issues:\n${result.stdout || result.stderr}`,
	};
}

export interface SizeCheckOptions {
	maxBytes?: number;
}

/**
 * Verify the final archive size does not exceed the configured limit.
 */
export function checkSize(archivePath: string, options: SizeCheckOptions = {}): CheckResult {
	const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const stat = fs.statSync(archivePath);
	if (stat.size <= limit) {
		return {
			name: "size",
			level: "ok",
			message: `${stat.size} bytes (limit ${limit})`,
		};
	}
	return {
		name: "size",
		level: "error",
		message: `archive is ${stat.size} bytes; exceeds limit of ${limit}`,
	};
}

/**
 * Walk a directory and return its total size in bytes. Used as a
 * pre-pack estimate before we actually invoke `tar`.
 */
export function dirSize(dir: string): number {
	let total = 0;
	function walk(current: string) {
		const entries = fs.readdirSync(current, { withFileTypes: true });
		for (const e of entries) {
			const full = path.join(current, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile()) total += fs.statSync(full).size;
		}
	}
	walk(dir);
	return total;
}
