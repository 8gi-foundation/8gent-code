#!/usr/bin/env bun
/**
 * 8gent-flow - Mac vision relay for local clients.
 *
 * The relay reuses @8gent/eyes for macOS screen capture. It does not call a
 * vision model itself. Clients receive throttled frames over a token-gated
 * WebSocket and can decide whether to ask the local agent to interpret them.
 *
 * 8gi:200-exempt - v0 keeps CLI, auth, and relay protocol together until the
 * iOS client contract stabilizes.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
	type BackendOpts,
	type CaptureOpts,
	DEFAULT_FAILOVER,
	type Eyes,
	type Frame,
	probeAxNativePermissions,
	selectEyesBackend,
} from "@8gent/eyes";
import {
	click as desktopClick,
	hover as desktopHover,
	press as desktopPress,
	scroll as desktopScroll,
	typeText as desktopType,
} from "../../../packages/computer/index.js";
import type {
	CommandResult,
	MouseButton,
	ScrollDirection,
} from "../../../packages/computer/types.js";

const PROTOCOL_VERSION = "8gent-flow.v1";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_PATH = "/flow";
const DEFAULT_FPS = 1;
const MAX_FPS = 2;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;

const EXIT_BACKEND_UNAVAILABLE = 3;
const EXIT_USAGE = 64;

export interface FlowConfig {
	host: string;
	port: number;
	path: string;
	fps: number;
	token: string | null;
	displayId?: CaptureOpts["displayId"];
	format: "jpeg" | "png";
	includeImage: boolean;
	maxFrameBytes: number;
	allowControl: boolean;
}

interface Argv {
	subcommand: string | null;
	flags: Record<string, string | boolean>;
	positional: string[];
}

interface FlowSocketData {
	id: string;
	authed: boolean;
}

interface ServeDeps {
	eyes?: Pick<Eyes, "capture">;
	control?: FlowControlDriver;
	now?: () => number;
}

export interface FlowRelay {
	url: string;
	localUrls: string[];
	token: string | null;
	port: number;
	stop(): void;
}

export interface FlowFramePayload {
	type: "flow.frame";
	protocol: typeof PROTOCOL_VERSION;
	frame: {
		id: string;
		width: number;
		height: number;
		displayId: number;
		capturedAt: number;
		scale: number;
		platform: Frame["platform"];
		format: "jpeg" | "png";
	};
	image?: {
		mime: "image/jpeg" | "image/png";
		encoding: "base64";
		bytes: number;
		data: string;
	};
	omitted?: {
		reason: string;
		bytes?: number;
	};
}

export interface FlowControlDriver {
	click(input: { x: number; y: number; button?: MouseButton; count?: number }):
		| CommandResult
		| Promise<CommandResult>;
	hover(input: { x: number; y: number }): CommandResult | Promise<CommandResult>;
	scroll(input: {
		direction: ScrollDirection;
		amount?: number;
		x?: number;
		y?: number;
	}): CommandResult | Promise<CommandResult>;
	typeText(input: { text: string; delay?: number }): CommandResult | Promise<CommandResult>;
	press(input: { keys: string; count?: number; delay?: number }):
		| CommandResult
		| Promise<CommandResult>;
}

type ControlMessage = Record<string, unknown> & {
	type?: string;
	id?: string;
};

function out(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(exit: number, reason: string, extra: Record<string, unknown> = {}): never {
	out({ ok: false, exit, reason, ...extra });
	process.exit(exit);
}

function parseArgv(raw: string[]): Argv {
	let subcommand: string | null = null;
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	let i = 0;
	while (i < raw.length) {
		const arg = raw[i] ?? "";
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const eq = key.indexOf("=");
			if (eq >= 0) {
				flags[key.slice(0, eq)] = key.slice(eq + 1);
			} else {
				const next = raw[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else if (subcommand === null) {
			subcommand = arg;
		} else {
			positional.push(arg);
		}
		i++;
	}
	return { subcommand, flags, positional };
}

function flagStr(argv: Argv, key: string): string | undefined {
	const value = argv.flags[key];
	return typeof value === "string" ? value : undefined;
}

function flagBool(argv: Argv, key: string): boolean {
	return argv.flags[key] === true || argv.flags[key] === "true";
}

function parseNumberFlag(
	argv: Argv,
	key: string,
	defaultValue: number,
	opts: { min: number; max: number },
): number {
	const raw = flagStr(argv, key);
	if (raw === undefined) return defaultValue;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < opts.min || n > opts.max) {
		fail(EXIT_USAGE, `--${key} must be a number from ${opts.min} to ${opts.max}`);
	}
	return n;
}

function parseDisplayFlag(raw?: string): CaptureOpts["displayId"] | undefined {
	if (raw === undefined) return undefined;
	if (raw === "primary" || raw === "all") return raw;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		fail(EXIT_USAGE, "--display must be primary, all, or a non-negative display index");
	}
	return n;
}

function normalizePath(path: string): string {
	if (!path.startsWith("/")) return `/${path}`;
	return path;
}

export function createPairToken(): string {
	return randomBytes(18).toString("base64url");
}

export function parseFlowConfig(raw: string[]): { subcommand: string | null; config: FlowConfig } {
	const argv = parseArgv(raw);
	const explicitToken = flagStr(argv, "token");
	const noToken = flagBool(argv, "no-token");
	if (explicitToken && noToken) fail(EXIT_USAGE, "use --token or --no-token, not both");
	const allowUnauthenticatedControl = flagBool(argv, "allow-unauthenticated-control");

	const format = flagStr(argv, "format") === "png" ? "png" : "jpeg";
	const config: FlowConfig = {
		host: flagStr(argv, "host") ?? DEFAULT_HOST,
		port: parseNumberFlag(argv, "port", DEFAULT_PORT, { min: 0, max: 65535 }),
		path: normalizePath(flagStr(argv, "path") ?? DEFAULT_PATH),
		fps: parseNumberFlag(argv, "fps", DEFAULT_FPS, { min: 0, max: MAX_FPS }),
		token: noToken ? null : (explicitToken ?? createPairToken()),
		displayId: parseDisplayFlag(flagStr(argv, "display")),
		format,
		includeImage: !flagBool(argv, "no-image"),
		maxFrameBytes: parseNumberFlag(argv, "max-frame-bytes", MAX_FRAME_BYTES, {
			min: 1,
			max: 50 * 1024 * 1024,
		}),
		allowControl: !flagBool(argv, "no-control") && (!noToken || allowUnauthenticatedControl),
	};

	return { subcommand: argv.subcommand, config };
}

function mimeFor(format: FlowConfig["format"]): "image/jpeg" | "image/png" {
	return format === "jpeg" ? "image/jpeg" : "image/png";
}

export async function frameToPayload(
	frame: Frame,
	config: Pick<FlowConfig, "format" | "includeImage" | "maxFrameBytes">,
): Promise<FlowFramePayload> {
	const payload: FlowFramePayload = {
		type: "flow.frame",
		protocol: PROTOCOL_VERSION,
		frame: {
			id: frame.id,
			width: frame.width,
			height: frame.height,
			displayId: frame.displayId,
			capturedAt: frame.capturedAt,
			scale: frame.scale,
			platform: frame.platform,
			format: config.format,
		},
	};

	if (!config.includeImage) {
		payload.omitted = { reason: "image-disabled" };
		return payload;
	}

	const bytes = frame.buffer ?? Buffer.from(await readFile(frame.path));
	if (bytes.byteLength > config.maxFrameBytes) {
		payload.omitted = { reason: "frame-too-large", bytes: bytes.byteLength };
		return payload;
	}

	payload.image = {
		mime: mimeFor(config.format),
		encoding: "base64",
		bytes: bytes.byteLength,
		data: Buffer.from(bytes).toString("base64"),
	};
	return payload;
}

function createDesktopControlDriver(): FlowControlDriver {
	return {
		click(input) {
			return desktopClick({
				point: { x: input.x, y: input.y },
				button: input.button,
				count: input.count,
			});
		},
		hover(input) {
			return desktopHover({ x: input.x, y: input.y });
		},
		scroll(input) {
			return desktopScroll({
				direction: input.direction,
				amount: input.amount,
				point:
					input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined,
			});
		},
		typeText(input) {
			return desktopType({ text: input.text, delay: input.delay });
		},
		press(input) {
			return desktopPress({ keys: input.keys, count: input.count, delay: input.delay });
		},
	};
}

function controlResultMessage(msg: ControlMessage, action: string, result: CommandResult): string {
	return JSON.stringify({
		type: "control.result",
		protocol: PROTOCOL_VERSION,
		id: msg.id,
		action,
		ok: result.ok,
		error: result.ok ? undefined : result.error,
	});
}

function controlErrorMessage(msg: ControlMessage, action: string, reason: string): string {
	return controlResultMessage(msg, action, { ok: false, error: reason });
}

function numberValue(msg: ControlMessage, key: string): number {
	const value = msg[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${key} must be a finite number`);
	}
	return value;
}

function optionalNumberValue(msg: ControlMessage, key: string): number | undefined {
	const value = msg[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${key} must be a finite number`);
	}
	return value;
}

function stringValue(msg: ControlMessage, key: string): string {
	const value = msg[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value;
}

function optionalMouseButton(msg: ControlMessage): MouseButton | undefined {
	const value = msg.button;
	if (value === undefined) return undefined;
	if (value === "left" || value === "right" || value === "middle") return value;
	throw new Error("button must be left, right, or middle");
}

function scrollDirection(msg: ControlMessage): ScrollDirection {
	const value = msg.direction;
	if (value === "up" || value === "down" || value === "left" || value === "right") return value;
	throw new Error("direction must be up, down, left, or right");
}

export async function executeControlMessage(
	msg: ControlMessage,
	control: FlowControlDriver,
): Promise<CommandResult> {
	switch (msg.type) {
		case "control.click":
			return control.click({
				x: numberValue(msg, "x"),
				y: numberValue(msg, "y"),
				button: optionalMouseButton(msg),
				count: optionalNumberValue(msg, "count"),
			});
		case "control.hover":
			return control.hover({
				x: numberValue(msg, "x"),
				y: numberValue(msg, "y"),
			});
		case "control.scroll":
			return control.scroll({
				direction: scrollDirection(msg),
				amount: optionalNumberValue(msg, "amount"),
				x: optionalNumberValue(msg, "x"),
				y: optionalNumberValue(msg, "y"),
			});
		case "control.type":
			return control.typeText({
				text: stringValue(msg, "text"),
				delay: optionalNumberValue(msg, "delay"),
			});
		case "control.press":
			return control.press({
				keys: stringValue(msg, "keys"),
				count: optionalNumberValue(msg, "count"),
				delay: optionalNumberValue(msg, "delay"),
			});
		default:
			return { ok: false, error: `unsupported control action: ${msg.type ?? "(missing)"}` };
	}
}

function localUrls(host: string, port: number, path: string): string[] {
	if (host !== "0.0.0.0" && host !== "::") return [`ws://${host}:${port}${path}`];

	const urls = new Set<string>();
	for (const iface of Object.values(networkInterfaces())) {
		for (const addr of iface ?? []) {
			if (addr.family === "IPv4" && !addr.internal) {
				urls.add(`ws://${addr.address}:${port}${path}`);
			}
		}
	}
	return [...urls].sort();
}

async function createEyes(): Promise<Pick<Eyes, "capture">> {
	const backend = await selectEyesBackend([...DEFAULT_FAILOVER]);
	if (!backend) {
		const permissions =
			process.platform === "darwin" ? await probeAxNativePermissions({}).catch(() => null) : null;
		const permissionReason = permissions && !permissions.ok ? permissions.reason : undefined;
		fail(
			EXIT_BACKEND_UNAVAILABLE,
			permissionReason
				? permissionReason
				: "no Mac perception backend available. Build it with: bash packages/eyes/native/build.sh",
		);
	}
	return backend.create({
		sessionId: `flow_${Date.now().toString(36)}`,
		actor: "8gent-flow",
	} as BackendOpts & { sessionId: string; actor: string });
}

function readyMessage(config: FlowConfig, relay: Pick<FlowRelay, "url" | "localUrls">): string {
	return JSON.stringify({
		type: "flow.ready",
		protocol: PROTOCOL_VERSION,
		url: relay.url,
		localUrls: relay.localUrls,
		fps: config.fps,
		tokenRequired: config.token !== null,
		control: {
			enabled: config.allowControl,
			actions: config.allowControl
				? ["control.click", "control.hover", "control.scroll", "control.type", "control.press"]
				: [],
		},
	});
}

function errorMessage(reason: string): string {
	return JSON.stringify({ type: "flow.error", protocol: PROTOCOL_VERSION, reason });
}

export async function serveFlow(config: FlowConfig, deps: ServeDeps = {}): Promise<FlowRelay> {
	const eyes = deps.eyes ?? (await createEyes());
	const control = config.allowControl ? (deps.control ?? createDesktopControlDriver()) : null;
	const now = deps.now ?? Date.now;
	const clients = new Set<Bun.ServerWebSocket<FlowSocketData>>();
	let captureInFlight = false;

	const server = Bun.serve<FlowSocketData>({
		hostname: config.host,
		port: config.port,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/health") {
				return Response.json({
					ok: true,
					protocol: PROTOCOL_VERSION,
					path: config.path,
					fps: config.fps,
					tokenRequired: config.token !== null,
					controlEnabled: config.allowControl,
				});
			}
			if (url.pathname !== config.path) {
				return new Response("8gent-flow relay\n", { status: 200 });
			}
			const upgraded = server.upgrade(req, {
				data: {
					id: `client_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
					authed: config.token === null,
				},
			});
			if (!upgraded) return new Response("upgrade failed", { status: 400 });
			return undefined;
		},
		websocket: {
			open(ws) {
				clients.add(ws);
				if (ws.data.authed) {
					ws.send(readyMessage(config, relay));
				} else {
					ws.send(JSON.stringify({ type: "flow.auth_required", protocol: PROTOCOL_VERSION }));
				}
			},
			message(ws, message) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(message));
				} catch {
					ws.send(errorMessage("message must be JSON"));
					return;
				}

				if (typeof parsed !== "object" || parsed === null) {
					ws.send(errorMessage("message must be an object"));
					return;
				}

				const msg = parsed as ControlMessage & { token?: string };
				if (msg.type === "hello") {
					if (config.token !== null && msg.token !== config.token) {
						ws.close(1008, "bad token");
						return;
					}
					ws.data.authed = true;
					ws.send(readyMessage(config, relay));
					return;
				}
				if (!ws.data.authed) {
					ws.close(1008, "auth required");
					return;
				}
				if (msg.type === "ping") {
					ws.send(JSON.stringify({ type: "flow.pong", protocol: PROTOCOL_VERSION }));
					return;
				}
				if (msg.type === "request_frame") {
					void captureAndSend(ws);
					return;
				}
				if (typeof msg.type === "string" && msg.type.startsWith("control.")) {
					void controlAndRefresh(ws, msg);
					return;
				}
				ws.send(errorMessage(`unknown message type: ${msg.type ?? "(missing)"}`));
			},
			close(ws) {
				clients.delete(ws);
			},
		},
	});

	if (typeof server.port !== "number") {
		server.stop(true);
		throw new Error("8gent-flow relay started without a bound port");
	}
	const boundPort = server.port;

	const relay: FlowRelay = {
		url: `ws://${config.host}:${boundPort}${config.path}`,
		localUrls: localUrls(config.host, boundPort, config.path),
		token: config.token,
		port: boundPort,
		stop() {
			if (timer) clearInterval(timer);
			for (const client of clients) client.close(1001, "relay stopped");
			server.stop(true);
		},
	};

	async function capturePayload(): Promise<FlowFramePayload> {
		const frame = await eyes.capture({
			displayId: config.displayId,
			format: config.format,
		});
		return frameToPayload(frame, config);
	}

	async function captureAndSend(ws: Bun.ServerWebSocket<FlowSocketData>): Promise<void> {
		try {
			ws.send(JSON.stringify(await capturePayload()));
		} catch (err) {
			ws.send(errorMessage(err instanceof Error ? err.message : String(err)));
		}
	}

	async function controlAndRefresh(
		ws: Bun.ServerWebSocket<FlowSocketData>,
		msg: ControlMessage,
	): Promise<void> {
		if (!control) {
			ws.send(
				controlErrorMessage(msg, msg.type ?? "control", "control is disabled for this relay"),
			);
			return;
		}
		try {
			const result = await executeControlMessage(msg, control);
			ws.send(controlResultMessage(msg, msg.type ?? "control", result));
			if (result.ok) void captureAndSend(ws);
		} catch (err) {
			ws.send(
				controlErrorMessage(
					msg,
					msg.type ?? "control",
					err instanceof Error ? err.message : String(err),
				),
			);
		}
	}

	async function broadcastFrame(): Promise<void> {
		if (captureInFlight) return;
		const authed = [...clients].filter((client) => client.data.authed);
		if (authed.length === 0) return;
		captureInFlight = true;
		try {
			const payload = JSON.stringify(await capturePayload());
			for (const client of authed) client.send(payload);
		} catch (err) {
			const msg = errorMessage(err instanceof Error ? err.message : String(err));
			for (const client of authed) client.send(msg);
		} finally {
			captureInFlight = false;
		}
	}

	const timer = config.fps > 0 ? setInterval(() => void broadcastFrame(), 1000 / config.fps) : null;
	return relay;
}

async function cmdOnce(config: FlowConfig): Promise<void> {
	const eyes = await createEyes();
	const frame = await eyes.capture({ displayId: config.displayId, format: config.format });
	out({ ok: true, payload: await frameToPayload(frame, config) });
}

async function cmdServe(config: FlowConfig): Promise<void> {
	const relay = await serveFlow(config);
	out({
		ok: true,
		type: "flow.relay_started",
		protocol: PROTOCOL_VERSION,
		url: relay.url,
		localUrls: relay.localUrls,
		token: relay.token,
		fps: config.fps,
		note: "For iOS on the same Wi-Fi, run with --host 0.0.0.0 and use one localUrls value.",
	});
	await new Promise(() => {});
}

function printHelp(): void {
	out({
		ok: true,
		usage:
			"8gent-flow serve [--host 0.0.0.0] [--port 8788] [--fps 1] [--display primary] [--token TOKEN] [--no-control]",
		subcommands: ["serve", "once"],
		defaults: {
			host: DEFAULT_HOST,
			port: DEFAULT_PORT,
			path: DEFAULT_PATH,
			fps: DEFAULT_FPS,
			format: "jpeg",
			control: "enabled when a pair token is required",
		},
		ios: "Use --host 0.0.0.0 for LAN/Tailscale clients. iOS sends hello with the pair token, then request_frame/control.* messages.",
	});
}

async function main(): Promise<void> {
	const { subcommand, config } = parseFlowConfig(process.argv.slice(2));
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		printHelp();
		return;
	}

	switch (subcommand) {
		case null:
		case "serve":
			await cmdServe(config);
			return;
		case "once":
			await cmdOnce(config);
			return;
		default:
			fail(EXIT_USAGE, `unknown subcommand: ${subcommand}`);
	}
}

if (import.meta.main) {
	main().catch((err) => fail(1, err instanceof Error ? err.message : String(err)));
}

export const TEST_ONLY = {
	PROTOCOL_VERSION,
	DEFAULT_PATH,
	MAX_FPS,
};
