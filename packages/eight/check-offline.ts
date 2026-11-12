/**
 * `8gent check-offline` (slice 1 of #240): run a short scripted local session
 * with outbound network blocked inside this process, and list every attempt.
 *
 * Refuses and records; it never sends. Loopback and unix sockets are local to
 * the device, so they pass and are not counted. It never downloads, installs or
 * calls a model off-box. Known gap: Bun gives ESM named imports of node:net,
 * node:tls, node:http(s) their own bindings, so `import { connect } from "node:net"`
 * can bypass the patch; fetch, default imports, require and Socket.connect are caught.
 * Exit 0 = no attempts, 1 = attempts, 2 = could not run.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

// ESM namespaces are read-only; the CommonJS module objects can be patched.
const req = createRequire(import.meta.url);
const http: typeof import("node:http") = req("node:http");
const https: typeof import("node:https") = req("node:https");
const net: typeof import("node:net") = req("node:net");
const tls: typeof import("node:tls") = req("node:tls");

export interface Attempt {
	via: string;
	host: string;
	port: string;
	caller: string;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;
const HERE = path.basename(new URL(import.meta.url).pathname);

function caller(): string {
	for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
		if (!line.includes(HERE) && !line.includes("node:")) return line.trim().replace(/^at /, "");
	}
	return "unknown";
}

function parseUrl(input: unknown): { host: string; port: string } {
	try {
		const raw = input instanceof Request ? input.url : String(input);
		const u = new URL(raw);
		return { host: u.hostname, port: u.port || (u.protocol === "http:" ? "80" : "443") };
	} catch {
		return { host: String(input), port: "" };
	}
}

/** Arm the guard. Returns the live attempt list and a restore function. */
export function armGuard(): { attempts: Attempt[]; restore: () => void } {
	const attempts: Attempt[] = [];
	const refuse = (via: string, host: string, port: string): never => {
		attempts.push({ via, host, port, caller: caller() });
		throw new Error(`check-offline: outbound ${via} to ${host}:${port} refused`);
	};
	const local = (host: string) => LOOPBACK.test(host);

	const origFetch = globalThis.fetch;
	globalThis.fetch = ((input: unknown, init?: unknown) => {
		const { host, port } = parseUrl(input);
		if (local(host)) return (origFetch as any)(input, init);
		try {
			refuse("fetch", host, port);
		} catch (e) {
			return Promise.reject(e);
		}
	}) as typeof fetch;

	const origConnect = net.Socket.prototype.connect;
	(net.Socket.prototype as any).connect = function (...args: any[]) {
		const o = args[0];
		if (typeof o === "string" && !/^\d+$/.test(o)) return origConnect.apply(this, args as any);
		if (o && typeof o === "object" && o.path) return origConnect.apply(this, args as any);
		const host = (o && typeof o === "object" ? o.host : args[1]) ?? "localhost";
		const port = String(o && typeof o === "object" ? o.port : o);
		if (local(String(host))) return origConnect.apply(this, args as any);
		return refuse("net", String(host), port);
	};

	const origNetConnect = net.connect;
	const origCreate = net.createConnection;
	const guardedConnect =
		(orig: (...a: any[]) => net.Socket) =>
		(...args: any[]) => {
			const o = args[0];
			if (typeof o === "string" && !/^\d+$/.test(o)) return orig(...args);
			if (o && typeof o === "object" && o.path) return orig(...args);
			const host = (o && typeof o === "object" ? o.host : args[1]) ?? "localhost";
			const port = String(o && typeof o === "object" ? o.port : o);
			if (local(String(host))) return orig(...args);
			return refuse("net", String(host), port);
		};
	(net as any).connect = guardedConnect(origNetConnect as any);
	(net as any).createConnection = guardedConnect(origCreate as any);

	const origTls = tls.connect;
	(tls as any).connect = (...args: any[]) => {
		const o = args[0];
		const host = (o && typeof o === "object" ? o.host : args[1]) ?? "localhost";
		const port = String(o && typeof o === "object" ? o.port : o);
		if (local(String(host))) return (origTls as any)(...args);
		return refuse("tls", String(host), port);
	};

	const origReq = [http.request, https.request];
	const wrap = (mod: typeof http | typeof https, name: "http" | "https") => {
		const orig = mod.request;
		(mod as any).request = (...args: any[]) => {
			const a = args[0];
			const u = typeof a === "string" || a instanceof URL ? new URL(String(a)) : null;
			const host = u ? u.hostname : (a?.hostname ?? a?.host ?? "localhost");
			const port = u ? u.port : String(a?.port ?? (name === "http" ? 80 : 443));
			if (a?.socketPath || local(String(host))) return (orig as any)(...args);
			return refuse(name, String(host), port);
		};
		(mod as any).get = (...args: any[]) => {
			const r = (mod as any).request(...args);
			r.end();
			return r;
		};
	};
	const origGet = [http.get, https.get];
	wrap(http, "http");
	wrap(https, "https");

	return {
		attempts,
		restore() {
			globalThis.fetch = origFetch;
			net.Socket.prototype.connect = origConnect;
			(net as any).connect = origNetConnect;
			(net as any).createConnection = origCreate;
			(tls as any).connect = origTls;
			http.request = origReq[0] as any;
			https.request = origReq[1] as any;
			http.get = origGet[0] as any;
			https.get = origGet[1] as any;
		},
	};
}

/** True when a local model file is already on this device. Never fetches one. */
export function hasLocalModel(root = path.join(os.homedir(), ".8gent", "models")): boolean {
	const walk = (dir: string, depth: number): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const e of entries) {
			if (e.isFile() && /\.(gguf|onnx|safetensors)$/i.test(e.name)) return true;
			if (e.isDirectory() && depth > 0 && walk(path.join(dir, e.name), depth - 1)) return true;
		}
		return false;
	};
	return walk(root, 3);
}

/** The default scripted session: load the start-up paths that could call home. */
async function defaultSession(): Promise<void> {
	await import("../providers/index.ts");
	await import("../local-model-server/index.ts");
}

export interface CheckOptions {
	session?: () => Promise<void>;
	modelRoot?: string;
	out?: (line: string) => void;
}

/** Run the check and return the exit code. */
export async function runCheckOffline(opts: CheckOptions = {}): Promise<number> {
	const out = opts.out ?? ((l: string) => console.log(l));
	if (!opts.session && !hasLocalModel(opts.modelRoot)) {
		out("check-offline: no local model is present, so the scripted session cannot run.");
		out("Nothing was downloaded or contacted. Install a local model yourself, then run it again.");
		return 2;
	}
	const guard = armGuard();
	try {
		await (opts.session ?? defaultSession)();
	} catch (e) {
		// A refused attempt is already recorded; any other failure is not a leak.
		if (!/check-offline: outbound/.test(String((e as Error)?.message))) {
			out(`check-offline: session error: ${(e as Error)?.message ?? e}`);
		}
	} finally {
		guard.restore();
	}
	if (guard.attempts.length === 0) {
		out("check-offline: 0 connection attempts. Nothing left this device.");
		return 0;
	}
	out(`check-offline: ${guard.attempts.length} connection attempt(s) caught and refused:`);
	for (const a of guard.attempts) out(`  ${a.via}  ${a.host}:${a.port}  from ${a.caller}`);
	return 1;
}
