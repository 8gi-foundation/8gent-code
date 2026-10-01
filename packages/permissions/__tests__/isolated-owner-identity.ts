/**
 * Test helper: run a test file against an isolated HOME and git config, so the
 * developer's own ~/.8gent/user.json and ~/.gitconfig never reach the
 * anonymizer's owner identity. Call once at the top level of a test file.
 */
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"] as const;

export interface IsolatedOwner {
	/** Write ~/.8gent/user.json with this identity name (optionally at a given mtime). */
	setProfileName(name: string, mtimeSec?: number): void;
	/** Write the isolated global git config. */
	setGitConfig(user: { name?: string; email?: string }): void;
}

export function isolateOwnerIdentity(): IsolatedOwner {
	const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	let home = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "8gent-owner-identity-"));
		process.env.HOME = home;
		process.env.GIT_CONFIG_GLOBAL = join(home, "isolated.gitconfig");
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	afterAll(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	return {
		setProfileName(name, mtimeSec) {
			const dir = join(home, ".8gent");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, "user.json");
			writeFileSync(file, JSON.stringify({ identity: { name } }));
			if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
		},
		setGitConfig(user) {
			const lines = ["[user]"];
			if (user.name) lines.push(`\tname = ${user.name}`);
			if (user.email) lines.push(`\temail = ${user.email}`);
			writeFileSync(join(home, "isolated.gitconfig"), `${lines.join("\n")}\n`);
		},
	};
}
