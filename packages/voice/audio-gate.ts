/**
 * Audio lane gate: may this process make sound right now?
 *
 * Same rule the System One audio lane uses: raw ~/.8gent/settings.json
 * voice.outputEnabled literally true, or EIGHT_VOICE=1. The raw file is read
 * on purpose: a merged default must never switch speech on for someone who
 * never asked. Anything unreadable means silence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/home.js";
import { TTSEngine } from "./tts-engine.js";

export function audioOutputAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.EIGHT_VOICE === "1") return true;
	try {
		const raw = JSON.parse(readFileSync(join(resolveHome(env), ".8gent", "settings.json"), "utf8"));
		return raw?.voice?.outputEnabled === true;
	} catch {
		return false;
	}
}

/**
 * Speak one line through the voice package (KittenTTS via python3, else macOS
 * say), only when the audio lane allows it. No engine on this machine is
 * silent, never an error. Resolves true when speech was started.
 */
export async function speakIfAllowed(
	line: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	try {
		if (!line.trim() || !audioOutputAllowed(env)) return false;
		const engine = new TTSEngine("kitten");
		const provider = await engine.getProvider();
		if (!(await provider.isAvailable())) return false;
		const proc = await provider.speak(line);
		proc.exited.catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}
