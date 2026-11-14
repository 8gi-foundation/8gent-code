#!/usr/bin/env bun
/**
 * table-server entry. Reads its whole configuration from the environment,
 * refuses to start on anything missing or unsafe, then serves.
 *
 *   EIGHT_DATA_DIR    absolute data dir (required). The ledger key is
 *                     <dir>/keys/state-hmac.key, the ledger <dir>/table/ledger/.
 *   TABLE_DB_PATH     the SQLite file (default <EIGHT_DATA_DIR>/table/table.db)
 *   TABLE_TOKEN_FILE  file holding the bearer token (required; regular file,
 *                     no group or other permission bits, at least 32 chars)
 *   TABLE_PORT        default 18789
 *   TABLE_BIND        default 127.0.0.1. Only the container image sets 0.0.0.0,
 *                     inside its own network namespace; compose decides the host
 *                     address it is published on.
 *
 *   --init-key        create the ledger key when it is absent. Without it a
 *                     missing key is an error: a new key silently started on an
 *                     imported store would make its ledger unverifiable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Ledger } from "../../../packages/goal/ledger";
import { getKeyPath, loadOrCreateKey } from "../../../packages/permissions/goal-state-hmac";
import { securityEnvSnapshot } from "../../../packages/permissions/security-env";
import { TableStore } from "../../../packages/table/store";
import { counts, startTableServer } from "./server";

export const MIN_TOKEN_CHARS = 32;

function die(message: string): never {
	process.stderr.write(`table-server: ${message}\n`);
	process.exit(2);
}

/** Read the bearer token, refusing a symlink, a non-regular file, loose permissions or a short token. */
export function readTokenFile(file: string): string {
	const st = fs.lstatSync(file);
	if (!st.isFile()) throw new Error(`${file} is not a regular file`);
	if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
		throw new Error(
			`${file} has mode ${(st.mode & 0o777).toString(8)}; it must allow no group or other access`,
		);
	const token = fs.readFileSync(file, "utf8").trim();
	if (token.length < MIN_TOKEN_CHARS)
		throw new Error(`${file} holds a token shorter than ${MIN_TOKEN_CHARS} chars`);
	return token;
}

function main(): void {
	const initKey = process.argv.includes("--init-key");

	// The same snapshot getKeyPath() reads, so the key and the data dir always agree.
	const dataDir = securityEnvSnapshot().values.EIGHT_DATA_DIR;
	if (!dataDir || !path.isAbsolute(dataDir))
		die("EIGHT_DATA_DIR must be set to an absolute path (and not declared in a .env file)");

	const tokenFile = process.env.TABLE_TOKEN_FILE;
	if (!tokenFile) die("TABLE_TOKEN_FILE is not set; refusing to start without auth");
	let token: string;
	try {
		token = readTokenFile(tokenFile);
	} catch (err) {
		die(`bad token file: ${(err as Error).message}`);
	}

	const keyPath = getKeyPath();
	if (!fs.existsSync(keyPath) && !initKey)
		die(`no ledger key at ${keyPath}. Run once with --init-key to create one for a new store.`);
	const key = loadOrCreateKey();

	const ledger = Ledger.open({ runId: "ledger", baseDir: path.join(dataDir, "table"), key });
	const checked = ledger.verify();
	if (!checked.ok) die(`ledger does not verify at seq ${checked.atSeq}: ${checked.reason}`);

	const dbPath = process.env.TABLE_DB_PATH || path.join(dataDir, "table", "table.db");
	const store = new TableStore({ dbPath, ledger });

	const port = Number(process.env.TABLE_PORT || 18789);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		die(`bad TABLE_PORT ${process.env.TABLE_PORT}`);
	const hostname = process.env.TABLE_BIND || "127.0.0.1";

	const server = startTableServer({ store, token, hostname, port });
	const c = counts(store);
	process.stdout.write(
		`table-server: listening on ${hostname}:${server.port} channels=${c.channels} members=${c.members} messages=${c.messages} ledger=${checked.count}\n`,
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
