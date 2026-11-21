/**
 * 8gent Code - Linux sandbox: bubblewrap + seccomp (gap register 8gi-governance#1108, lane 3)
 *
 * The Linux counterpart of seatbelt.ts, for unattended runs on a Linux box. Same intent as the
 * seatbelt profile, enforced differently:
 *
 *   - Filesystem, deny by default. The command starts in an empty mount namespace and sees only
 *     what is bound in: the read-only system dirs a program needs to start, its work dir
 *     (read/write), and its manifest read and write scopes. Nothing else exists: no /home, no
 *     /root, no /run, no /var, no /sys. Credential stores that sit inside a granted scope are
 *     masked LAST (an empty read-only tmpfs over a folder, /dev/null over a file), the same way
 *     seatbelt denies them last, and a scope inside a credential store is dropped, not bound.
 *   - Network, deny by default: a fresh network namespace with only a downed loopback.
 *     allowNetwork shares the host network and the resolver config.
 *   - Process: new user, pid, ipc, uts and cgroup namespaces, all capabilities dropped, a new
 *     session (no TIOCSTI into the caller's terminal), killed with its parent, and the seccomp
 *     filter from seccomp-bpf.ts loaded before exec.
 *
 * Needs: bubblewrap installed by the operator (we never install it) and unprivileged user
 * namespaces allowed (Ubuntu 24.04: the bwrap AppArmor profile). No root, no daemon, no KVM.
 * When either is missing the sandbox reports itself unavailable; the caller refuses the run,
 * it never falls back to running the command unsandboxed.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sensitiveCredentialPaths } from "./seatbelt.js";
import { buildSeccompProgram, encodeSeccompProgram, seccompArchFor } from "./seccomp-bpf.js";

// ============================================
// Types
// ============================================

export interface BwrapSpec {
	/** Directory the command may read AND write. Required, absolute. */
	workDir: string;
	/** Extra directories the command may read (manifest read scopes). */
	readPaths?: string[];
	/** Extra directories the command may read and write (manifest write scopes). */
	writePaths?: string[];
	/** Share the host network. Default: false (empty network namespace). */
	allowNetwork?: boolean;
	/** Paths masked even inside granted scopes. Default: sensitiveCredentialPaths(). */
	denyPaths?: string[];
	/** Environment for the command. Everything else is cleared. */
	env?: Record<string, string>;
	/** fd number the seccomp program is readable on in the bwrap process. Omit for no filter. */
	seccompFd?: number;
}

/** What a path is on the host, for masking. Injectable so argument building stays pure. */
export type PathKind = "dir" | "file" | "missing";

export function hostPathKind(p: string): PathKind {
	try {
		return fs.statSync(p).isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

// ============================================
// Availability
// ============================================

/** Fixed install locations; PATH is not consulted so a planted bwrap cannot be picked up. */
export const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

export type BwrapStatus =
	| { available: true; binary: string }
	| { available: false; reason: string };

let cachedStatus: BwrapStatus | undefined;

/** Reset the cached probe (tests). */
export function resetBwrapStatus(): void {
	cachedStatus = undefined;
}

/**
 * Can this host run the bwrap sandbox? Checks platform, binary, architecture, and runs one
 * real probe sandbox, because an installed bwrap is useless where user namespaces are refused.
 */
export function bwrapStatus(): BwrapStatus {
	if (cachedStatus) return cachedStatus;
	cachedStatus = probe();
	return cachedStatus;
}

function probe(): BwrapStatus {
	if (process.platform !== "linux") {
		return {
			available: false,
			reason: `bubblewrap runs on Linux only (this is ${process.platform})`,
		};
	}
	if (!seccompArchFor()) {
		return { available: false, reason: `no seccomp table for architecture ${process.arch}` };
	}
	const binary = BWRAP_CANDIDATES.find((p) => fs.existsSync(p));
	if (!binary) {
		return {
			available: false,
			reason: `bubblewrap not installed (looked in ${BWRAP_CANDIDATES.join(", ")})`,
		};
	}
	const r = spawnSync(
		binary,
		["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"],
		{
			encoding: "utf8",
			timeout: 5_000,
			env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
		},
	);
	if (r.status !== 0) {
		const err = (r.stderr || r.error?.message || `exit ${r.status}`).trim();
		const hint = /uid map|Permission denied|Operation not permitted/.test(err)
			? " (unprivileged user namespaces are blocked; on Ubuntu 24.04 load the bwrap-userns-restrict AppArmor profile)"
			: "";
		return { available: false, reason: `bubblewrap probe failed: ${err}${hint}` };
	}
	return { available: true, binary };
}

// ============================================
// Argument building (pure)
// ============================================

/**
 * What any program needs to start. Read-only. /etc is included as on macOS (/private/etc);
 * its secrets are root-only and the sandbox has no capabilities. /run, /var, /home, /root,
 * /sys and /mnt are deliberately absent.
 */
export const BWRAP_SYSTEM_RO = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/etc",
	"/opt",
	"/nix/store",
];

/** Resolver folders /etc/resolv.conf commonly links into; bound only when network is allowed. */
const RESOLVER_DIRS = ["/run/systemd/resolve", "/run/resolvconf"];

const isWithin = (child: string, parent: string) =>
	child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

const depth = (p: string) => p.split("/").filter(Boolean).length;

/**
 * Build the bwrap argument list (everything between the binary and `--`).
 *
 * Bind order matters: bwrap mounts in order and a later mount covers an earlier one. So the
 * system dirs come first, then the granted scopes from shallowest to deepest (a read scope
 * inside the work dir stays read-only, a work dir inside a read scope stays writable), and the
 * credential masks last so nothing granted can uncover them.
 */
export function buildBwrapArgs(
	spec: BwrapSpec,
	kind: (p: string) => PathKind = hostPathKind,
): string[] {
	const workDir = path.normalize(spec.workDir);
	if (!path.isAbsolute(workDir)) {
		throw new Error(`bwrap: workDir must be absolute, got "${spec.workDir}"`);
	}
	for (const p of [...(spec.readPaths ?? []), ...(spec.writePaths ?? [])]) {
		if (!path.isAbsolute(p)) throw new Error(`bwrap: scope paths must be absolute, got "${p}"`);
	}
	const denyPaths = (spec.denyPaths ?? sensitiveCredentialPaths()).map((p) => path.normalize(p));
	const insideDeny = (p: string) => denyPaths.some((d) => isWithin(p, d));
	if (insideDeny(workDir)) {
		throw new Error(`bwrap: workDir "${workDir}" is inside a credential store`);
	}

	const args: string[] = [
		"--unshare-all",
		...(spec.allowNetwork ? ["--share-net"] : []),
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--clearenv",
	];
	for (const [k, v] of Object.entries(spec.env ?? {})) args.push("--setenv", k, v);

	for (const d of BWRAP_SYSTEM_RO) args.push("--ro-bind-try", d, d);
	if (spec.allowNetwork) for (const d of RESOLVER_DIRS) args.push("--ro-bind-try", d, d);
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

	type Bind = { path: string; write: boolean; required: boolean };
	const binds = new Map<string, Bind>();
	for (const p of spec.readPaths ?? []) {
		const n = path.normalize(p);
		if (!insideDeny(n) && !binds.has(n)) binds.set(n, { path: n, write: false, required: false });
	}
	for (const p of spec.writePaths ?? []) {
		const n = path.normalize(p);
		if (!insideDeny(n)) binds.set(n, { path: n, write: true, required: false });
	}
	binds.set(workDir, { path: workDir, write: true, required: true });

	const ordered = [...binds.values()].sort((a, b) => depth(a.path) - depth(b.path));
	for (const b of ordered) {
		const flag = b.write ? (b.required ? "--bind" : "--bind-try") : "--ro-bind-try";
		args.push(flag, b.path, b.path);
	}

	// Mask credential stores that a granted scope (or a system dir) would otherwise expose.
	const exposed = [...ordered.map((b) => b.path), ...BWRAP_SYSTEM_RO];
	for (const d of denyPaths) {
		if (!exposed.some((root) => isWithin(d, root))) continue;
		const k = kind(d);
		if (k === "dir") args.push("--tmpfs", d, "--remount-ro", d);
		else if (k === "file") args.push("--ro-bind", "/dev/null", d);
	}

	if (spec.seccompFd !== undefined) args.push("--seccomp", String(spec.seccompFd));
	args.push("--chdir", workDir);
	return args;
}

/** Full argv: binary, sandbox args, then the shell running the command. */
export function buildBwrapArgv(
	binary: string,
	spec: BwrapSpec,
	command: string,
	kind: (p: string) => PathKind = hostPathKind,
): string[] {
	return [binary, ...buildBwrapArgs(spec, kind), "--", "/bin/sh", "-c", command];
}

/** The seccomp program for this host as bytes, or undefined on an architecture we lack. */
export function seccompBytesForHost(): Uint8Array | undefined {
	const arch = seccompArchFor();
	return arch ? encodeSeccompProgram(buildSeccompProgram(arch)) : undefined;
}
