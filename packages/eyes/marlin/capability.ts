/**
 * @8gent/eyes — marlin capability gate.
 *
 * The video-ingestion capability (Marlin sidecar + PyTorch venv) is OFF BY
 * DEFAULT, mirroring the kernel pipeline (`packages/kernel/manager.ts`,
 * `enabled: false`). A fresh `npm install -g @8gi-foundation/8gent-code`
 * carries no Python. Installing it is an explicit, consented user action
 * (`8gent vision install`) per VIDEO-INGESTION spec §11.
 *
 * "Installed" means BOTH:
 *   1. The provisioned uv venv exists at `~/.8gent/venvs/marlin/`.
 *   2. Config flag `vision.videoIngestion` is true in `~/.8gent/config.json`,
 *      or the env override `EIGHT_VIDEO_INGESTION=1` is set.
 *
 * Either missing → the tool returns a structured "install required" error
 * and never silently no-ops (spec §6 step 3).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of the uv-managed virtualenv that hosts the Marlin sidecar. */
export function marlinVenvDir(): string {
	return join(homedir(), ".8gent", "venvs", "marlin");
}

/** The Python interpreter inside the provisioned venv. */
export function marlinVenvPython(): string {
	return join(marlinVenvDir(), "bin", "python");
}

/** Path to the user's 8gent config. */
function configPath(): string {
	return join(homedir(), ".8gent", "config.json");
}

/** Whether the `vision.videoIngestion` flag is enabled in config or env. */
function isFlagEnabled(): boolean {
	if (process.env.EIGHT_VIDEO_INGESTION === "1") return true;
	const cfg = configPath();
	if (!existsSync(cfg)) return false;
	try {
		const parsed = JSON.parse(readFileSync(cfg, "utf-8")) as {
			vision?: { videoIngestion?: boolean };
		};
		return parsed.vision?.videoIngestion === true;
	} catch {
		return false;
	}
}

export interface CapabilityStatus {
	/** True only if both the venv and the flag are present. */
	installed: boolean;
	/** Whether the opt-in flag is on. */
	flagEnabled: boolean;
	/** Whether the provisioned venv interpreter exists on disk. */
	venvPresent: boolean;
	/** Human-readable reason the capability is unavailable, if any. */
	reason?: string;
	/** The action that resolves the unavailable state (install vs config). */
	suggestion?: string;
}

/** Inspect the install state of the video-ingestion capability. */
export function checkVideoCapability(): CapabilityStatus {
	const flagEnabled = isFlagEnabled();
	const venvPresent = existsSync(marlinVenvPython());
	if (flagEnabled && venvPresent) {
		return { installed: true, flagEnabled, venvPresent };
	}
	let reason: string;
	let suggestion: string;
	if (!flagEnabled && !venvPresent) {
		reason =
			"Video understanding is not installed. Run `8gent vision install` to provision the local Marlin sidecar, then it is enabled automatically.";
		suggestion = "8gent vision install";
	} else if (!venvPresent) {
		reason =
			"Video understanding is enabled in config but the Marlin sidecar venv is missing. Run `8gent vision install` to provision it.";
		suggestion = "8gent vision install";
	} else {
		// venv present, flag off — the fix is a config edit, not a reinstall.
		reason =
			"The Marlin sidecar venv is provisioned but video understanding is disabled. Set `vision.videoIngestion` to true in ~/.8gent/config.json (or EIGHT_VIDEO_INGESTION=1).";
		suggestion =
			"Set `vision.videoIngestion` to true in ~/.8gent/config.json, or set EIGHT_VIDEO_INGESTION=1.";
	}
	return { installed: false, flagEnabled, venvPresent, reason, suggestion };
}
