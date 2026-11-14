#!/usr/bin/env bun
/**
 * table-server entry. Reads its whole configuration from the environment,
 * refuses to start on anything missing or unsafe, then serves.
 *
 *   EIGHT_DATA_DIR        absolute data dir (required). The ledger is
 *                         <dir>/table/ledger/, the default key <dir>/keys/state-hmac.key.
 *   TABLE_TOKENS_FILE     identity table (required): one "<sha256 hex of token> human:<handle>"
 *                         per line. Regular file, owned by this uid, mode 0600.
 *   TABLE_KEY_FILE        optional: the 32-byte ledger HMAC key, read-only, owned by this
 *                         uid, mode 0600 (for example a SOPS secret under /run/8gi/secrets).
 *                         Keeps the key off the data volume. When set, --init-key is refused.
 *   TABLE_DB_PATH         the SQLite file (default <EIGHT_DATA_DIR>/table/table.db)
 *   TABLE_PORT            default 18789
 *   TABLE_BIND            default 127.0.0.1. Only the container image sets 0.0.0.0,
 *                         inside its own network namespace; compose decides the host
 *                         address it is published on.
 *   TABLE_MAX_CONNECTIONS open WebSockets, default 64
 *   TABLE_AUTH_TIMEOUT_MS close an unauthenticated socket after this, default 5000
 *
 *   --init-key            create <EIGHT_DATA_DIR>/keys/state-hmac.key when it is absent.
 *                         Without it a missing key is an error: a new key silently started
 *                         on an imported store would make its ledger unverifiable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Ledger } from "../../../packages/goal/ledger";
import { getKeyPath, loadOrCreateKey } from "../../../packages/permissions/goal-state-hmac";
import { securityEnvSnapshot } from "../../../packages/permissions/security-env";
import { TableStore } from "../../../packages/table/store";
import {
	counts,
	DEFAULT_AUTH_TIMEOUT_MS,
	DEFAULT_MAX_CONNECTIONS,
	parseTokens,
	startTableServer,
	type TokenEntry,
} from "./server";

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function die(message: string): never {
	process.stderr.write(`table-server: ${message}\n`);
	process.exit(2);
}

/**
 * Read a secret file: a regular file (never a symlink), owned by this uid,
 * with no group or other permission bits. Opened O_NOFOLLOW and re-checked
 * on the descriptor, so a swap after the lstat is caught.
 */
export function readPrivateFile(file: string): Buffer {
	const check = (st: fs.Stats) => {
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		if (process.platform === "win32") return;
		if (typeof process.getuid === "function" && st.uid !== process.getuid())
			throw new Error(`${file} is owned by uid ${st.uid}, not ${process.getuid()}`);
		if ((st.mode & 0o077) !== 0)
			throw new Error(`${file} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600`);
	};
	check(fs.lstatSync(file));
	const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	try {
		check(fs.fstatSync(fd));
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function readTokens(file: string): TokenEntry[] {
	const tokens = parseTokens(readPrivateFile(file).toString("utf8"));
	if (tokens.length === 0) throw new Error(`${file} holds no tokens`);
	return tokens;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];
	const n = raw === undefined || raw === "" ? fallback : Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) die(`bad ${name} ${raw}`);
	return n;
}

function loadKey(initKey: boolean): Buffer {
	const keyFile = process.env.TABLE_KEY_FILE;
	if (keyFile) {
		if (initKey)
			die("--init-key cannot be used with TABLE_KEY_FILE; create the key where the secret lives");
		const key = readPrivateFile(keyFile);
		if (key.length !== 32) die(`${keyFile} must hold exactly 32 bytes, not ${key.length}`);
		return key;
	}
	const keyPath = getKeyPath();
	if (!fs.existsSync(keyPath) && !initKey)
		die(`no ledger key at ${keyPath}. Run once with --init-key to create one for a new store.`);
	return loadOrCreateKey();
}

function main(): void {
	const initKey = process.argv.includes("--init-key");

	// The same snapshot getKeyPath() reads, so the key and the data dir always agree.
	const dataDir = securityEnvSnapshot().values.EIGHT_DATA_DIR;
	if (!dataDir || !path.isAbsolute(dataDir))
		die("EIGHT_DATA_DIR must be set to an absolute path (and not declared in a .env file)");

	const tokensFile = process.env.TABLE_TOKENS_FILE;
	if (!tokensFile) die("TABLE_TOKENS_FILE is not set; refusing to start without auth");
	let tokens: TokenEntry[] = [];
	try {
		tokens = readTokens(tokensFile);
	} catch (err) {
		die(`bad tokens file: ${(err as Error).message}`);
	}

	let key: Buffer = Buffer.alloc(0);
	try {
		key = loadKey(initKey);
	} catch (err) {
		die(`bad ledger key: ${(err as Error).message}`);
	}

	const ledger = Ledger.open({ runId: "ledger", baseDir: path.join(dataDir, "table"), key });
	const checked = ledger.verify();
	if (!checked.ok) die(`ledger does not verify at seq ${checked.atSeq}: ${checked.reason}`);

	const dbPath = process.env.TABLE_DB_PATH || path.join(dataDir, "table", "table.db");
	const store = new TableStore({ dbPath, ledger });

	const port = envInt("TABLE_PORT", 18789, 0, 65535);
	const hostname = process.env.TABLE_BIND || "127.0.0.1";
	const maxConnections = envInt("TABLE_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS, 1, 10_000);
	const authTimeoutMs = envInt("TABLE_AUTH_TIMEOUT_MS", DEFAULT_AUTH_TIMEOUT_MS, 100, 60_000);

	const server = startTableServer({ store, tokens, hostname, port, maxConnections, authTimeoutMs });
	const c = counts(store);
	process.stdout.write(
		`table-server: listening on ${hostname}:${server.port} channels=${c.channels} members=${c.members} messages=${c.messages} ledger=${checked.count} tokens=${tokens.length}\n`,
	);

	const stop = () => {
		server.stop(true);
		store.close();
		ledger.close();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

if (import.meta.main) main();
