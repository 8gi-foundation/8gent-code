/**
 * @8gent/voice - Input device resolver and first-run check.
 *
 * The recorder (sox `rec`) always records from the OS default input, so the
 * device NAME is for display and diagnosis. It is resolved at the start of
 * every recording and never cached, so plugging in headphones or switching to
 * AirPods applies on the next press with no restart.
 */

import { spawn } from "bun";

export interface InputDevice {
	/** Human-readable device name, or null when it could not be determined */
	name: string | null;
	/** Which OS facility answered (for diagnosis) */
	source: "system_profiler" | "pactl" | "powershell" | "unknown";
}

/** Runs a command, returns stdout, or null on failure or timeout. */
export type CommandRunner = (cmd: string[], timeoutMs: number) => Promise<string | null>;

export const DEVICE_LOOKUP_TIMEOUT_MS = 2500;

export const defaultRunner: CommandRunner = async (cmd, timeoutMs) => {
	try {
		const proc = spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, timeoutMs);
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		clearTimeout(timer);
		return code === 0 ? out : null;
	} catch {
		return null;
	}
};

const UNKNOWN: InputDevice = { name: null, source: "unknown" };

/** macOS: the item flagged as the default input in `system_profiler SPAudioDataType -json`. */
export function parseMacDefaultInput(json: string): string | null {
	try {
		const root = JSON.parse(json) as {
			SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }>;
		};
		for (const group of root.SPAudioDataType ?? []) {
			for (const item of group._items ?? []) {
				if (item.coreaudio_default_audio_input_device === "spaudio_yes") {
					const name = item._name;
					return typeof name === "string" && name.trim() ? name.trim() : null;
				}
			}
		}
	} catch {}
	return null;
}

/** Linux: description of `sourceName` from `pactl list sources`, if present. */
export function parsePactlDescription(listing: string, sourceName: string): string | null {
	let inBlock = false;
	for (const raw of listing.split("\n")) {
		const line = raw.trim();
		const nameMatch = line.match(/^Name:\s*(.+)$/);
		if (nameMatch) inBlock = nameMatch[1].trim() === sourceName;
		if (inBlock) {
			const desc = line.match(/^Description:\s*(.+)$/);
			if (desc) return desc[1].trim();
		}
	}
	return null;
}

const WINDOWS_SCRIPT =
	"$ErrorActionPreference='SilentlyContinue';" +
	"$d=Get-AudioDevice -Recording; if($d){$d.Name}else{" +
	"(Get-PnpDevice -Class AudioEndpoint -Status OK | Where-Object {$_.FriendlyName -match 'Microphone|Mic|Input|Headset'} | Select-Object -First 1).FriendlyName}";

/**
 * Resolve the current default input device. Fresh on every call.
 * Never throws; returns { name: null } when the OS cannot tell us.
 */
export async function resolveInputDevice(
	opts: { platform?: NodeJS.Platform; run?: CommandRunner } = {},
): Promise<InputDevice> {
	const platform = opts.platform ?? process.platform;
	const run = opts.run ?? defaultRunner;
	const t = DEVICE_LOOKUP_TIMEOUT_MS;
	try {
		if (platform === "darwin") {
			const out = await run(["system_profiler", "SPAudioDataType", "-json"], t);
			const name = out ? parseMacDefaultInput(out) : null;
			return name ? { name, source: "system_profiler" } : UNKNOWN;
		}
		if (platform === "linux") {
			const out = await run(["pactl", "get-default-source"], t);
			const sourceName = out?.trim();
			if (!sourceName) return UNKNOWN;
			const listing = await run(["pactl", "list", "sources"], t);
			const pretty = listing ? parsePactlDescription(listing, sourceName) : null;
			return { name: pretty ?? sourceName, source: "pactl" };
		}
		if (platform === "win32") {
			const out = await run(
				["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
				t,
			);
			const name = out?.trim().split(/\r?\n/)[0]?.trim();
			return name ? { name, source: "powershell" } : UNKNOWN;
		}
	} catch {}
	return UNKNOWN;
}

/** Text shown in the voice indicator and `/voice test`. */
export function formatMicLabel(device: InputDevice | string | null | undefined): string {
	const name = typeof device === "string" ? device : device?.name;
	return `Mic: ${name && name.trim() ? name.trim() : "unknown device"}`;
}

export interface VoiceSetupInputs {
	soxPath: string | null;
	whisperBinaryPath: string | null;
	downloadedModels: string[];
	modelsDir: string;
	cloudAvailable?: boolean;
	platform?: NodeJS.Platform;
}

/** One clear line per missing piece. Empty array means everything is in place. */
export function describeMissingVoiceSetup(i: VoiceSetupInputs): string[] {
	const platform = i.platform ?? process.platform;
	const lines: string[] = [];
	if (!i.soxPath) {
		const hint =
			platform === "darwin"
				? "brew install sox"
				: platform === "linux"
					? "sudo apt install sox (or your distro's package)"
					: "install SoX from https://sox.sourceforge.net/";
		lines.push(`sox not found (needed to record): ${hint}`);
	}
	if (!i.whisperBinaryPath) {
		lines.push(
			platform === "darwin"
				? "whisper.cpp binary not found: brew install whisper-cpp"
				: "whisper.cpp binary not found: build or install whisper.cpp and put it on PATH",
		);
	}
	if (i.downloadedModels.length === 0) {
		lines.push(`No whisper model found in ${i.modelsDir}: download one (tiny is about 75 MB)`);
	}
	return lines;
}

/** Which transcriber the next recording will use. */
export function describeTranscriberBackend(i: {
	whisperBinaryPath: string | null;
	downloadedModels: string[];
	model?: string;
	cloudAvailable?: boolean;
	mode?: "local" | "cloud";
}): string {
	const localReady = !!i.whisperBinaryPath && i.downloadedModels.length > 0;
	if (i.mode === "cloud" || (!localReady && i.cloudAvailable)) return "Transcriber: OpenAI Whisper (cloud)";
	if (localReady) {
		const model = i.model && i.downloadedModels.includes(i.model) ? i.model : i.downloadedModels[0];
		return `Transcriber: whisper.cpp local (${model})`;
	}
	return "Transcriber: none available";
}
