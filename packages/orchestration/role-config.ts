/**
 * Role Config - single source of truth for {role -> provider + model}.
 *
 * Stored at `~/.8gent/roles.json` (override via EIGHT_ROLE_CONFIG_DIR env for tests).
 * Atomic writes: write to `.tmp`, then rename. Never leaves a half-written file.
 *
 * Consumed by `createClientForRole()` in `packages/eight/clients/index.ts`
 * and `runClaimedTask()` in `packages/orchestration/role-runner.ts`.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ProviderName } from "../providers";
import { isAppleFoundationAvailable } from "../providers";

export interface RoleModelAssignment {
	provider: ProviderName;
	model: string;
}

export type RoleName = "orchestrator" | "engineer" | "qa";

export interface RoleConfig {
	schemaVersion: 1;
	orchestrator: RoleModelAssignment;
	engineer: RoleModelAssignment;
	qa: RoleModelAssignment;
	fallback: RoleModelAssignment;
}

/**
 * Resolve the directory holding `roles.json`. Tests can point this at a
 * temp dir via EIGHT_ROLE_CONFIG_DIR without touching the real home.
 */
function configDir(): string {
	const override = process.env.EIGHT_ROLE_CONFIG_DIR;
	if (override && override.length > 0) return override;
	return path.join(os.homedir(), ".8gent");
}

function configPath(): string {
	return path.join(configDir(), "roles.json");
}

function tmpPath(): string {
	return path.join(configDir(), "roles.json.tmp");
}

/**
 * Platform-aware defaults.
 *
 * - darwin + arm64 + apple-foundation bridge present: all roles use apple-foundation.
 * - darwin + arm64 without the bridge: all roles use the local 8gent runtime.
 * - everything else: all roles use ollama / qwen3:14b.
 */
export function defaultRoleConfig(): RoleConfig {
	const isDarwinArm = process.platform === "darwin" && process.arch === "arm64";

	let assignment: RoleModelAssignment;
	if (isDarwinArm && isAppleFoundationAvailable()) {
		assignment = {
			provider: "apple-foundation",
			model: "apple-foundationmodel",
		};
	} else if (isDarwinArm) {
		assignment = { provider: "8gent", model: "eight-1.0-q3:14b" };
	} else {
		assignment = { provider: "ollama", model: "qwen3:14b" };
	}

	return {
		schemaVersion: 1,
		orchestrator: { ...assignment },
		engineer: { ...assignment },
		qa: { ...assignment },
		fallback: { ...assignment },
	};
}

function isValidAssignment(value: unknown): value is RoleModelAssignment {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.provider === "string" && typeof v.model === "string";
}

function isValidConfig(value: unknown): value is RoleConfig {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== 1) return false;
	return (
		isValidAssignment(v.orchestrator) &&
		isValidAssignment(v.engineer) &&
		isValidAssignment(v.qa) &&
		isValidAssignment(v.fallback)
	);
}

/**
 * Load role config from disk. Returns defaults if the file is missing,
 * unreadable, malformed JSON, or fails schema validation.
 */
export function loadRoleConfig(): RoleConfig {
	const file = configPath();
	try {
		if (!fs.existsSync(file)) return defaultRoleConfig();
		const raw = fs.readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw);
		if (!isValidConfig(parsed)) return defaultRoleConfig();
		return parsed;
	} catch {
		return defaultRoleConfig();
	}
}

/**
 * Save role config to disk atomically.
 *
 * Writes to `roles.json.tmp` then renames to `roles.json`. If the process
 * crashes between write and rename, the previous `roles.json` is untouched.
 */
export function saveRoleConfig(cfg: RoleConfig): void {
	const dir = configDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const tmp = tmpPath();
	const final = configPath();
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
	fs.renameSync(tmp, final);
}
