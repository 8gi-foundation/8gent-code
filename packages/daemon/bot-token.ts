/**
 * Bot token loader (#99, slice of #97).
 *
 * A bot token must not sit in the daemon's environment: a same-uid child can
 * read the launch environment from /proc/<pid>/environ (#97). So the token is
 * read once at start into module memory and never written to process.env.
 *
 * Source order:
 *   1. $CREDENTIALS_DIRECTORY/<credentialName>   (systemd LoadCredential=)
 *   2. a fixed file <data dir>/secrets/<credentialName> (~/.8gent/secrets/...)
 *   3. the environment variable (legacy). The variable is deleted from
 *      process.env right after it is read, with a one-line warning that names
 *      the variable and never its value.
 * A variable that is also present when a file source won is deleted too.
 *
 * There is deliberately no config.json source: a model turn can write that file,
 * and a path in it could point the daemon at an attacker's token or any 0600 file.
 *
 * The fixed file must be mode 0600 or stricter, owned by the daemon's uid, and its
 * realpath must stay inside the secrets directory (a symlink out is refused).
 * The credential directory is systemd's and gets the mode check only.
 *
 * What this does not fix: the initial environ block of a process is fixed at
 * exec, so a token that arrived through the launch environment stays visible in
 * /proc/<pid>/environ until a re-exec. Deferred by the board (#97).
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { dataDirPath } from "./data-dir";

type Env = Record<string, string | undefined>;

export interface BotTokenSpec {
	/** Legacy environment variable, e.g. TELEGRAM_BOT_TOKEN. */
	envVar: string;
	/** systemd credential / secrets file name, e.g. telegram-bot-token. */
	credentialName: string;
	/** Test seams. Defaults: <data dir>/secrets and process.getuid(). */
	secretsDir?: string;
	uid?: number;
}

const held = new Map<string, string>();

function readOwnerOnly(path: string): string {
	const mode = statSync(path).mode & 0o777;
	if (mode & 0o077) {
		throw new Error(`token file ${path} is mode ${mode.toString(8)}; must be 0600 or stricter`);
	}
	return readFileSync(path, "utf8").trim();
}

/** The fixed secrets file: 0600, ours, and really inside the secrets directory. */
function readSecretsFile(spec: BotTokenSpec): string | undefined {
	const dir = spec.secretsDir ?? join(dataDirPath(), "secrets");
	const file = join(dir, spec.credentialName);
	if (!existsSync(file)) return undefined;
	const real = realpathSync(file);
	if (!real.startsWith(realpathSync(dir) + sep)) {
		throw new Error(`token file ${file} resolves outside ${dir}; refused`);
	}
	const owner = statSync(real).uid;
	const uid = spec.uid ?? process.getuid?.();
	if (uid !== undefined && owner !== uid) {
		throw new Error(`token file ${real} is owned by uid ${owner}, not ${uid}; refused`);
	}
	return readOwnerOnly(real);
}

/**
 * Load a bot token into memory and scrub its environment variable.
 * Returns undefined when no source has one. Repeat calls return the held value.
 */
export function loadBotToken(spec: BotTokenSpec, env: Env = process.env): string | undefined {
	const cached = held.get(spec.envVar);
	const fromEnv = env[spec.envVar];
	if (fromEnv !== undefined) {
		delete env[spec.envVar];
		console.warn(
			`[daemon] ${spec.envVar} was in the process environment; removed it. Supply it as a credential file instead.`,
		);
	}

	let token: string | undefined;
	const credDir = env.CREDENTIALS_DIRECTORY;
	if (credDir && existsSync(join(credDir, spec.credentialName))) {
		token = readOwnerOnly(join(credDir, spec.credentialName));
	} else {
		token = readSecretsFile(spec);
	}
	if (!token && fromEnv) token = fromEnv.trim();
	// The first call deleted the env var, so a later call with no file source falls back to memory.
	if (!token) token = cached;
	if (token) held.set(spec.envVar, token);
	return token || undefined;
}

/** Test seam: forget held tokens. */
export function _resetBotTokens(): void {
	held.clear();
}
