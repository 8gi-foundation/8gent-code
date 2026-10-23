/**
 * The slice of the Bun runtime API that 8gent's CLI and TUI paths use, on Node.
 * Used only by the Node build (scripts/build-node.ts): it aliases the "bun"
 * module to this file and installs globalThis.Bun from it. Under Bun nothing
 * here loads. Anything outside the slice throws a clear error, never silently
 * misbehaves.
 */
import {
	type ChildProcess,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, existsSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve } from "./bun-serve";

// biome-ignore lint/suspicious/noExplicitAny: the Node boundary mirrors Bun's loose shapes
type Loose = any;

type Stdio = "pipe" | "inherit" | "ignore" | number | null | undefined;
interface SpawnOpts {
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: Stdio | Blob | string | Uint8Array;
	stdout?: Stdio;
	stderr?: Stdio;
	timeout?: number;
	killSignal?: NodeJS.Signals | number;
	windowsHide?: boolean;
	windowsVerbatimArguments?: boolean;
	onExit?: (proc: unknown, code: number | null, signal: string | null) => void;
}

/** The options handed to node:child_process, kept pure so a test can assert the pass-through. */
export function buildSpawnOptions(o: SpawnOpts, stdio: unknown[]) {
	return {
		cwd: o.cwd,
		env: (o.env as NodeJS.ProcessEnv) ?? process.env,
		stdio: stdio as Loose,
		timeout: o.timeout,
		killSignal: o.killSignal,
		windowsHide: o.windowsHide,
		windowsVerbatimArguments: o.windowsVerbatimArguments,
	};
}

/** Bun throws when the executable is not found; Node would emit an async error. Match Bun. */
function assertExecutable(argv: string[], o: SpawnOpts): void {
	const bin = argv[0];
	if (!bin) throw new TypeError("spawn: empty command");
	const env = (o.env as NodeJS.ProcessEnv) ?? process.env;
	const hasSep = bin.includes("/") || bin.includes("\\");
	const found = hasSep
		? isExecutableFile(resolvePath(o.cwd ?? process.cwd(), bin))
		: which(bin, { PATH: env.PATH });
	if (!found) {
		const err = new Error(`Executable not found in $PATH: "${bin}"`) as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	}
}

function stdioOf(v: Stdio | Blob | string | Uint8Array, dflt: "pipe" | "ignore" | "inherit") {
	if (v === undefined || v === null) return dflt;
	if (typeof v === "string" && (v === "pipe" || v === "inherit" || v === "ignore")) return v;
	if (typeof v === "number") return v;
	return "pipe"; // buffer-like stdin is written after spawn
}

function normSpawn(cmd: string[] | ({ cmd: string[] } & SpawnOpts), opts: SpawnOpts = {}) {
	const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
	const o = Array.isArray(cmd) ? opts : { ...cmd, ...opts };
	return { argv, o };
}

class NodeSubprocess {
	readonly pid: number | undefined;
	readonly stdin: { write(d: string | Uint8Array): number; end(): void; flush(): void } | null;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number>;
	exitCode: number | null = null;
	signalCode: string | null = null;
	killed = false;
	constructor(
		private readonly child: ChildProcess,
		input?: Blob | string | Uint8Array,
	) {
		this.pid = child.pid;
		this.stdout = child.stdout
			? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>)
			: null;
		this.stderr = child.stderr
			? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>)
			: null;
		const sin = child.stdin;
		this.stdin = sin
			? {
					write: (d) => {
						sin.write(d);
						return typeof d === "string" ? Buffer.byteLength(d) : d.byteLength;
					},
					end: () => void sin.end(),
					flush: () => {},
				}
			: null;
		if (sin) sin.on("error", () => {}); // EPIPE after the child exits is not our crash
		if (sin && input !== undefined && typeof input !== "number") {
			if (typeof input === "string" || input instanceof Uint8Array) sin.end(input);
			else void (input as Blob).arrayBuffer().then((b) => sin.end(Buffer.from(b)));
		}
		this.exited = new Promise<number>((resolve) => {
			child.on("error", () => {
				this.exitCode = this.exitCode ?? 127;
				resolve(127);
			});
			child.on("close", (code, signal) => {
				this.exitCode = code;
				this.signalCode = signal;
				resolve(code ?? (signal ? 128 : 0));
			});
		});
	}
	kill(sig?: NodeJS.Signals | number): void {
		this.killed = true;
		this.child.kill(sig);
	}
	unref(): void {
		this.child.unref();
	}
	ref(): void {
		this.child.ref();
	}
}

export function spawn(
	cmd: string[] | ({ cmd: string[] } & SpawnOpts),
	opts?: SpawnOpts,
): NodeSubprocess {
	const { argv, o } = normSpawn(cmd, opts);
	assertExecutable(argv, o);
	const child = nodeSpawn(
		argv[0],
		argv.slice(1),
		buildSpawnOptions(o, [
			stdioOf(o.stdin, "ignore"),
			stdioOf(o.stdout, "pipe"),
			stdioOf(o.stderr, "inherit"),
		]),
	);
	const input =
		typeof o.stdin === "object" || typeof o.stdin === "string" ? (o.stdin as Loose) : undefined;
	const proc = new NodeSubprocess(child, o.stdin === "pipe" ? undefined : input);
	if (o.onExit) void proc.exited.then((c) => o.onExit?.(proc, c, proc.signalCode));
	return proc;
}

export function spawnSync(cmd: string[] | ({ cmd: string[] } & SpawnOpts), opts?: SpawnOpts) {
	const { argv, o } = normSpawn(cmd, opts);
	assertExecutable(argv, o);
	const r = nodeSpawnSync(argv[0], argv.slice(1), {
		...buildSpawnOptions(o, [
			stdioOf(o.stdin, "ignore"),
			stdioOf(o.stdout, "pipe"),
			stdioOf(o.stderr, "pipe"),
		]),
		input: typeof o.stdin === "string" || o.stdin instanceof Uint8Array ? o.stdin : undefined,
	});
	return {
		exitCode: r.status ?? (r.signal ? 128 : 127),
		success: r.status === 0,
		stdout: r.stdout ?? Buffer.alloc(0),
		stderr: r.stderr ?? Buffer.alloc(0),
	};
}

class NodeFile {
	constructor(readonly path: string) {}
	get name() {
		return this.path;
	}
	async text(): Promise<string> {
		return readFile(this.path, "utf8");
	}
	async json(): Promise<Loose> {
		return JSON.parse(await this.text());
	}
	async arrayBuffer(): Promise<ArrayBuffer> {
		const b = await readFile(this.path);
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	}
	async bytes(): Promise<Uint8Array> {
		return new Uint8Array(await readFile(this.path));
	}
	async exists(): Promise<boolean> {
		return existsSync(this.path);
	}
	get size(): number {
		try {
			return statSync(this.path).size;
		} catch {
			return 0;
		}
	}
	stream(): ReadableStream<Uint8Array> {
		return Readable.toWeb(
			Readable.from([readFileSync(this.path)]),
		) as unknown as ReadableStream<Uint8Array>;
	}
}

async function write(dest: string | NodeFile, data: unknown): Promise<number> {
	const path = typeof dest === "string" ? dest : dest.path;
	await mkdir(dirname(path), { recursive: true });
	let buf: Buffer;
	if (typeof data === "string") buf = Buffer.from(data);
	else if (data instanceof NodeFile) buf = await readFile(data.path);
	else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
	else if (ArrayBuffer.isView(data))
		buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	else if (data && typeof (data as Response).arrayBuffer === "function")
		buf = Buffer.from(await (data as Response).arrayBuffer());
	else throw new Error("Bun.write: unsupported data type on Node");
	await writeFile(path, buf);
	return buf.byteLength;
}

function isExecutableFile(p: string): boolean {
	try {
		if (!statSync(p).isFile()) return false;
		accessSync(p, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** First executable match on PATH. Empty or relative PATH entries are skipped: they mean "the cwd". */
export function which(bin: string, o: { PATH?: string } = {}): string | null {
	const exts =
		process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (o.PATH ?? process.env.PATH ?? "").split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue;
		for (const e of exts) {
			const p = join(dir, bin + e);
			if (isExecutableFile(p)) return p;
		}
	}
	return null;
}

function unsupported(name: string) {
	return () => {
		throw new Error(
			`${name} is not available when 8gent runs on Node. Install Bun for this feature (https://bun.sh).`,
		);
	};
}

/** UUIDv7: 48-bit ms timestamp, version 7, variant 10, random remainder. */
export function randomUUIDv7(): string {
	const b = randomBytes(16);
	const ms = BigInt(Date.now());
	for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
	b[6] = (b[6] & 0x0f) | 0x70;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const stdinShim = {
	stream: () => Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
	async arrayBuffer(): Promise<ArrayBuffer> {
		const chunks: Buffer[] = [];
		for await (const c of process.stdin) chunks.push(Buffer.from(c));
		const b = Buffer.concat(chunks);
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	},
	async text(): Promise<string> {
		return Buffer.from(await this.arrayBuffer()).toString("utf8");
	},
	async json(): Promise<Loose> {
		return JSON.parse(await this.text());
	},
};

export const BunShim = {
	stdin: stdinShim,
	version: "node-compat",
	argv: process.argv,
	env: process.env,
	spawn,
	spawnSync,
	file: (p: string | URL) => new NodeFile(typeof p === "string" ? p : fileURLToPath(p)),
	write,
	which,
	sleep: (ms: number | Date) =>
		new Promise<void>((r) => setTimeout(r, ms instanceof Date ? ms.getTime() - Date.now() : ms)),
	nanoseconds: () => Number(process.hrtime.bigint()),
	randomUUIDv7,
	serve,
	connect: unsupported("Bun.connect"),
	listen: unsupported("Bun.listen"),
	Transpiler: unsupported("Bun.Transpiler"),
	Glob: unsupported("Bun.Glob"),
	resolveSync: (id: string, from: string) => {
		return createRequire(join(from, "noop.js")).resolve(id);
	},
};
