/**
 * `8gent check-offline` (#240): run a short scripted session in a child process
 * whose outbound network is denied by the operating system, and list what it
 * tried. The verdict comes from that enforcement, never from observation.
 *
 * macOS: sandbox-exec with (deny network*), loopback and unix sockets allowed.
 * Linux: unshare -rnm (a new empty network namespace, loopback brought up).
 * If neither works here it says so and exits 3. It never reports a clean run
 * without enforcement. In-process hooks (fetch, net, tls, http(s), WebSocket,
 * Bun.connect) only LIST attempts so the user can see who tried; they are not
 * the guarantee. It never downloads, installs or calls a model off-box.
 *
 * Exit 0 = ran enforced, nothing listed. 1 = attempts listed. 2 = no local
 * model. 3 = could not enforce, or the child did not report.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const LOOPBACK = new RegExp(
	`^(localhost|127\\.${OCTET}\\.${OCTET}\\.${OCTET}|::1|\\[::1\\])$`,
	"i",
);

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
	const hasLookup = (o: any) => !!o && typeof o === "object" && o.lookup !== undefined;
	/** Decide a host/port connect call; returns true when it may proceed. */
	const allow = (via: string, args: any[]): boolean => {
		const o = args[0];
		if (typeof o === "string" && !/^\d+$/.test(o)) return true;
		if (o && typeof o === "object" && o.path) return true;
		const host = String((o && typeof o === "object" ? o.host : args[1]) ?? "localhost");
		const port = String(o && typeof o === "object" ? o.port : o);
		if (args.some(hasLookup)) refuse(via, host, port);
		if (!local(host)) refuse(via, host, port);
		return true;
	};

	const origFetch = globalThis.fetch;
	globalThis.fetch = ((input: unknown, init?: unknown) => {
		const { host, port } = parseUrl(input);
		const i = init as any;
		if (local(host) && !i?.proxy && !i?.unix && !hasLookup(i))
			return (origFetch as any)(input, init);
		try {
			refuse("fetch", i?.proxy ? `${host} via proxy` : i?.unix ? `${host} via unix` : host, port);
		} catch (e) {
			return Promise.reject(e);
		}
	}) as typeof fetch;

	const origConnect = net.Socket.prototype.connect;
	(net.Socket.prototype as any).connect = function (...args: any[]) {
		allow("net", args);
		return origConnect.apply(this, args as any);
	};

	const origNetConnect = net.connect;
	const origCreate = net.createConnection;
	const guardedConnect =
		(orig: (...a: any[]) => net.Socket) =>
		(...args: any[]) => {
			allow("net", args);
			return orig(...args);
		};
	(net as any).connect = guardedConnect(origNetConnect as any);
	(net as any).createConnection = guardedConnect(origCreate as any);

	const origTls = tls.connect;
	(tls as any).connect = (...args: any[]) => {
		allow("tls", args);
		return (origTls as any)(...args);
	};

	const origReq = [http.request, https.request];
	const wrap = (mod: typeof http | typeof https, name: "http" | "https") => {
		const orig = mod.request;
		(mod as any).request = (...args: any[]) => {
			const a = args[0];
			const u = typeof a === "string" || a instanceof URL ? new URL(String(a)) : null;
			const host = u ? u.hostname : (a?.hostname ?? a?.host ?? "localhost");
			const port = u ? u.port : String(a?.port ?? (name === "http" ? 80 : 443));
			if (args.some(hasLookup)) return refuse(name, String(host), port);
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

	const origWS = (globalThis as any).WebSocket;
	if (origWS) {
		(globalThis as any).WebSocket = new Proxy(origWS, {
			construct(target, args) {
				const { host, port } = parseUrl(args[0]);
				if (!local(host) || hasLookup(args[1])) refuse("websocket", host, port);
				return Reflect.construct(target, args);
			},
		});
	}
	const bun = (globalThis as any).Bun;
	const origBunConnect = bun?.connect;
	if (origBunConnect) {
		bun.connect = (o: any, ...rest: any[]) => {
			if (!o?.unix) {
				const host = String(o?.hostname ?? "localhost");
				if (!local(host) || hasLookup(o)) refuse("bun.connect", host, String(o?.port ?? ""));
			}
			return origBunConnect.call(bun, o, ...rest);
		};
	}

	return {
		attempts,
		restore() {
			if (origWS) (globalThis as any).WebSocket = origWS;
			if (origBunConnect) bun.connect = origBunConnect;
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
async function defaultSession(): Promise<unknown> {
	await import("../providers/index.ts");
	await import("../local-model-server/index.ts");
	return undefined;
}

const MARK = "__CHECK_OFFLINE_RESULT__";
const SANDBOX_PROFILE = [
	"(version 1)",
	"(allow default)",
	"(deny network*)",
	'(allow network* (remote ip "localhost:*"))',
	'(allow network* (local ip "localhost:*"))',
	"(allow network* (remote unix-socket))",
	"(allow network* (local unix-socket))",
	// Later rules win. Close the relays that send for the process: DNS, URL
	// sessions, Launch Services (`open https://...`).
	'(deny mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.dnssd.service") (global-name "com.apple.nsurlsessiond") (global-name "com.apple.coreservices.launchservicesd"))',
	'(deny network* (remote unix-socket (path-literal "/var/run/mDNSResponder")))',
	'(deny network* (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
].join("\n");

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((k) => [
	k,
	k.toLowerCase(),
]);

/** The child's environment: ours, without any proxy setting. */
export function childEnv(
	base: NodeJS.ProcessEnv,
	extra: Record<string, string>,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, ...extra };
	for (const k of PROXY_VARS) delete env[k];
	return env;
}

export interface Enforcer {
	mechanism: string;
	wrap: (argv: string[]) => string[];
}

/** Find an OS mechanism that really works here, by running `true` under it. */
export function findEnforcer(platform = process.platform): Enforcer | null {
	const candidates: Enforcer[] = [];
	if (platform === "darwin") {
		candidates.push({
			mechanism: "sandbox-exec",
			wrap: (argv) => ["/usr/bin/sandbox-exec", "-p", SANDBOX_PROFILE, ...argv],
		});
	} else if (platform === "linux") {
		candidates.push({
			mechanism: "unshare -rnm",
			// -m: hide the resolver and nscd sockets (unix sockets cross network
			// namespaces) behind an empty tmpfs where the mount is allowed.
			wrap: (argv) => [
				"/usr/bin/unshare",
				"-rnm",
				"/bin/sh",
				"-c",
				'ip link set lo up 2>/dev/null; for d in /run/systemd/resolve /run/nscd /var/run/nscd; do [ -d "$d" ] && mount -t tmpfs tmpfs "$d" 2>/dev/null; done; exec "$@"',
				"sh",
				...argv,
			],
		});
	}
	for (const c of candidates) {
		const [cmd, ...args] = c.wrap(["true"]);
		const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10000 });
		if (r.status === 0) return c;
	}
	return null;
}

/** Hooks only list. Run a session with them armed and return what they saw. */
export async function runListing(
	session: () => Promise<unknown>,
	hooks = true,
): Promise<{ attempts: Attempt[]; result: unknown; error?: string }> {
	const guard = hooks ? armGuard() : { attempts: [] as Attempt[], restore() {} };
	let result: unknown;
	let error: string | undefined;
	try {
		result = await session();
	} catch (e) {
		if (!/check-offline: outbound/.test(String((e as Error)?.message))) {
			error = String((e as Error)?.message ?? e);
		}
	} finally {
		guard.restore();
	}
	return { attempts: guard.attempts, result, error };
}

/** The lines printed after an enforced run. Pinned by a test. */
export function verdictLines(mechanism: string, attempts: Attempt[]): string[] {
	return [
		`check-offline: ran with outbound network blocked by the operating system (${mechanism}). The in-process hooks listed ${attempts.length} attempt(s) below; refusals the operating system made outside the hooks are not listed. Loopback and local sockets were allowed.`,
		"Not blocked: traffic that local services forward for the process (the DNS resolver, systemd-resolved, nscd, local proxies, a local model server, docker.sock), and file writes such as a LaunchAgent. Proxy environment variables were removed from the child.",
		...attempts.map((a) => `  ${a.via}  ${a.host}:${a.port}  from ${a.caller}`),
	];
}

export interface CheckOptions {
	/** Module (absolute path) whose default export is the scripted session. */
	sessionFile?: string;
	hooks?: boolean;
	modelRoot?: string;
	enforcer?: Enforcer | null;
	out?: (line: string) => void;
	/** Test seam: return the child's raw stdout for an argv instead of spawning it. */
	spawn?: (argv: string[]) => { status: number | null; stdout: string };
}

/** Run the check and return the exit code. */
export async function runCheckOffline(opts: CheckOptions = {}): Promise<number> {
	const out = opts.out ?? ((l: string) => console.log(l));
	if (!opts.sessionFile && !hasLocalModel(opts.modelRoot)) {
		out("check-offline: no local model is present, so the scripted session cannot run.");
		out("Nothing was downloaded or contacted. Install a local model yourself, then run it again.");
		return 2;
	}
	const enforcer = opts.enforcer === undefined ? findEnforcer() : opts.enforcer;
	if (!enforcer) {
		out(
			"check-offline: this machine has no working way to block the network for a child process (sandbox-exec on macOS, unshare -rnm on Linux).",
		);
		out("Nothing was run and no result is given. A clean result needs enforcement.");
		return 3;
	}
	const self = fileURLToPath(import.meta.url);
	if (!fs.existsSync(self)) {
		out("check-offline: cannot start the isolated child from this build. Nothing was run.");
		return 3;
	}
	const argv = enforcer.wrap([process.execPath, self, "--child"]);
	const reportFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "check-offline-")), "report");
	const env = childEnv(process.env, {
		CHECK_OFFLINE_REPORT: reportFile,
		CHECK_OFFLINE_SESSION: opts.sessionFile ?? "",
		CHECK_OFFLINE_HOOKS: opts.hooks === false ? "0" : "1",
	});
	const run =
		opts.spawn ??
		((a: string[]) => {
			// The report comes back in a file the child appends to last, not on stdout.
			const r = spawnSync(a[0], a.slice(1), {
				env,
				encoding: "utf8",
				timeout: 120000,
				stdio: "ignore",
			});
			let stdout = "";
			try {
				stdout = fs.readFileSync(reportFile, "utf8");
			} catch {}
			return { status: r.status, stdout };
		});
	const r = run(argv);
	const fail = (cause: string) => {
		out(`check-offline: ${cause}. Nothing is claimed.`);
		return 3;
	};
	if (r.status !== 0) return fail(`the isolated child exited with status ${r.status}`);
	const lines = r.stdout.split("\n").filter((l) => l.startsWith(MARK));
	const line = lines[lines.length - 1];
	if (!line) return fail("the isolated child did not report");
	let report: { attempts: Attempt[]; error?: string };
	try {
		report = JSON.parse(line.slice(MARK.length));
		if (!Array.isArray(report.attempts)) throw new Error("no attempts array");
	} catch {
		return fail("the isolated child's report could not be read");
	}
	if (report.error) return fail(`the session failed: ${report.error}`);
	for (const l of verdictLines(enforcer.mechanism, report.attempts)) out(l);
	return report.attempts.length === 0 ? 0 : 1;
}

/** Child entry: runs inside the OS sandbox, prints the marker line, exits. */
async function childMain(): Promise<void> {
	const file = process.env.CHECK_OFFLINE_SESSION;
	const session = file ? async () => (await import(file)).default() : defaultSession;
	const { attempts, result, error } = await runListing(
		session,
		process.env.CHECK_OFFLINE_HOOKS !== "0",
	);
	fs.appendFileSync(
		process.env.CHECK_OFFLINE_REPORT as string,
		`${MARK}${JSON.stringify({ attempts, result, error })}\n`,
	);
	process.exit(0);
}

if ((import.meta as { main?: boolean }).main && process.argv.includes("--child")) {
	await childMain();
}
