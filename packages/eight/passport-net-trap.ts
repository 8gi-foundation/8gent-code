import dns from "node:dns";
/**
 * Test preload for passport.test.ts: every network entry point records its name to
 * $PASSPORT_NET_LOG and throws. Loaded with `bun --preload` in front of the real bin/8gent.ts.
 */
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const log = process.env.PASSPORT_NET_LOG ?? "";
const trap =
	(name: string) =>
	(..._args: unknown[]): never => {
		if (log) fs.appendFileSync(log, `${name}\n`);
		throw new Error(`network call during passport: ${name}`);
	};

globalThis.fetch = trap("fetch") as unknown as typeof fetch;
net.connect = trap("net.connect") as unknown as typeof net.connect;
net.createConnection = trap("net.createConnection") as unknown as typeof net.createConnection;
tls.connect = trap("tls.connect") as unknown as typeof tls.connect;
http.request = trap("http.request") as unknown as typeof http.request;
http.get = trap("http.get") as unknown as typeof http.get;
https.request = trap("https.request") as unknown as typeof https.request;
https.get = trap("https.get") as unknown as typeof https.get;
dns.lookup = trap("dns.lookup") as unknown as typeof dns.lookup;
if (log) fs.appendFileSync(log, "");
