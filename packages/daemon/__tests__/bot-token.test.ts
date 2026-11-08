/**
 * #99 / #97: the daemon holds the bot token in memory and never in process.env.
 * The startup cases boot the real daemon startup (main() in packages/daemon/index.ts)
 * in a subprocess and inspect a child it spawns afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetBotTokens, loadBotToken } from "../bot-token";

const FAKE = "fake-0000:planted-by-test-99";
const HARNESS = join(import.meta.dir, "fixtures", "token-startup-harness.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	_resetBotTokens();
});

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "bot-token-"));
	dirs.push(root);
	const data = join(root, "data");
	const cred = join(root, "cred");
	mkdirSync(data);
	mkdirSync(cred);
	return { root, data, cred };
}

function boot(extra: Record<string, string>, data: string) {
	const port = String(20000 + Math.floor(Math.random() * 20000));
	const r = Bun.spawnSync(["bun", HARNESS, FAKE, "--local"], {
		env: {
			PATH: process.env.PATH as string,
			HOME: data,
			EIGHT_DATA_DIR: data,
			EIGHT_DAEMON_PORT: port,
			...extra,
		},
		timeout: 90_000,
	});
	const all = r.stdout.toString() + r.stderr.toString();
	const line = all.split("\n").find((l) => l.startsWith("RESULT "));
	if (!line) throw new Error(`no RESULT line\n${all}`);
	return { res: JSON.parse(line.slice(7)), all };
}

describe("bot token at daemon startup", () => {
	test("a credential file works and the token never reaches an environ", () => {
		const { data, cred } = sandbox();
		writeFileSync(join(cred, "telegram-bot-token"), `${FAKE}\n`, { mode: 0o600 });
		const { res, all } = boot({ CREDENTIALS_DIRECTORY: cred }, data);
		expect(res.envHasToken).toBe(false);
		expect(res.childEnvHits).toBe(0);
		expect(res.explicitEnvHits).toBe(0);
		// Linux: climbs every ancestor's /proc/<pid>/environ. Elsewhere /proc is absent and this is 0.
		expect(res.procHits).toBe(0);
		expect(all).not.toContain(FAKE);
		expect(all).not.toContain("was in the process environment");
	}, 120_000);

	test("an env-supplied token is removed from process.env, warned about by name, and a child cannot see it", () => {
		const { data } = sandbox();
		const { res, all } = boot({ TELEGRAM_BOT_TOKEN: FAKE }, data);
		expect(res.envHasToken).toBe(false);
		expect(res.childEnvHits).toBe(0);
		expect(res.explicitEnvHits).toBe(0);
		expect(all).toContain("TELEGRAM_BOT_TOKEN was in the process environment");
		expect(all).not.toContain(FAKE);
		// Known residual, deliberately not asserted: the launch environ block is fixed at
		// exec, so on Linux /proc/<daemon pid>/environ still lists it until a re-exec (#97, deferred).
	}, 120_000);
});

describe("loadBotToken", () => {
	const spec = { envVar: "TELEGRAM_BOT_TOKEN", credentialName: "telegram-bot-token" };

	test("a 0600 file named in config.json is read; a loose file is refused", () => {
		const { root, data } = sandbox();
		const f = join(root, "tok");
		writeFileSync(f, FAKE, { mode: 0o600 });
		const configPath = join(data, "config.json");
		writeFileSync(configPath, JSON.stringify({ daemon: { tokenFiles: { "telegram-bot-token": f } } }));
		expect(loadBotToken({ ...spec, configPath }, {})).toBe(FAKE);
		_resetBotTokens();
		chmodSync(f, 0o644);
		expect(() => loadBotToken({ ...spec, configPath }, {})).toThrow(/0600/);
	});

	test("a credential file wins over the env var, and the env var is still removed", () => {
		const { cred } = sandbox();
		writeFileSync(join(cred, "telegram-bot-token"), "from-file", { mode: 0o400 });
		const env: Record<string, string | undefined> = {
			CREDENTIALS_DIRECTORY: cred,
			TELEGRAM_BOT_TOKEN: "from-env",
		};
		expect(loadBotToken(spec, env)).toBe("from-file");
		expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
	});

	test("a missing credential falls back to the env var, which is then removed", () => {
		const { cred } = sandbox();
		const env: Record<string, string | undefined> = {
			CREDENTIALS_DIRECTORY: cred,
			TELEGRAM_BOT_TOKEN: "from-env",
		};
		expect(loadBotToken(spec, env)).toBe("from-env");
		expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
	});
});
