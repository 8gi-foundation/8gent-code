/**
 * Eight Daemon - Always-on agent process.
 *
 * Starts WebSocket gateway, heartbeat, cron scheduler, and event bus.
 * Logs to ~/.8gent/daemon.log. Graceful shutdown on SIGTERM/SIGINT.
 *
 * Local mode (`--local` flag or `EIGHT_DAEMON_LOCAL=1`):
 *   - Binds the WebSocket gateway to 127.0.0.1 (loopback only).
 *   - Disables remote vessel mesh registration even if GROVE_ENABLED=1.
 *   - Optional Telegram bridge auto-starts when EIGHT_TELEGRAM_LOCAL=1.
 *
 * Required env vars for the local Telegram bridge:
 *   - TELEGRAM_BOT_TOKEN              Bot token for the local bridge.
 *   - TELEGRAM_AUTHORIZED_CHAT_IDS    Comma-separated chat_id allowlist.
 *                                     Only James's chat_id should appear here.
 *   - EIGHT_TELEGRAM_LOCAL=1          Opt-in to auto-starting the bridge.
 *
 * Secrets are read from process.env or any pre-loaded env file. The daemon
 * never prints token contents. See `packages/daemon/scripts/start-local.ts`
 * for the canonical launcher.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { ComputerUseTraceStore, defaultTraceDbPath } from "../memory/computer-use-traces";
import { type TaskPayload, type TaskResult, VesselMesh } from "../orchestration/vessel-mesh";
import { AgentPool, loadPoolConfig } from "./agent-pool";
import { addJob, getJobs, startCron, stopCron } from "./cron";
import { getDataDir } from "./data-dir";
import {
	type DispatchExecutor,
	DispatchHub,
	DispatchLedger,
	DispatchRateLimiter,
	DispatchRouter,
	LocalTokenVerifier,
	SurfaceRegistry,
	resolveLocalDispatchSecret,
} from "./dispatch";
import { bus } from "./events";
import { startGateway } from "./gateway";
import { type GoalExecutorFactory, GoalManager } from "./goal-rpc";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { resolveBestFreeModel } from "./model-resolver";
import type { DaemonChannel } from "./types";

const PORT = 18789;
const DATA_DIR = getDataDir();
const LOG_PATH = `${DATA_DIR}/daemon.log`;
const CONFIG_PATH = `${DATA_DIR}/config.json`;
const DEFAULT_MODEL = "qwen3.5:14b";

interface DaemonConfig {
	port: number;
	authToken: string | null;
	heartbeatIntervalMs: number;
	heartbeatEnabled: boolean;
}

async function loadConfig(): Promise<DaemonConfig> {
	const defaults: DaemonConfig = {
		port: PORT,
		authToken: null,
		heartbeatIntervalMs: 30 * 60 * 1000,
		heartbeatEnabled: true,
	};

	try {
		const file = Bun.file(CONFIG_PATH);
		if (!(await file.exists())) return defaults;
		const raw = await file.json();
		const daemon = raw?.daemon || {};
		return {
			port: daemon.port ?? defaults.port,
			authToken: daemon.authToken ?? defaults.authToken,
			heartbeatIntervalMs: daemon.heartbeatIntervalMs ?? defaults.heartbeatIntervalMs,
			heartbeatEnabled: daemon.heartbeatEnabled ?? defaults.heartbeatEnabled,
		};
	} catch {
		return defaults;
	}
}

function setupLogging(): void {
	if (!existsSync(DATA_DIR)) {
		mkdirSync(DATA_DIR, { recursive: true });
	}

	// Subscribe to all events and append to log file
	const events = [
		"tool:start",
		"tool:result",
		"agent:thinking",
		"agent:stream",
		"agent:error",
		"memory:saved",
		"approval:required",
		"session:start",
		"session:end",
	] as const;

	for (const event of events) {
		bus.on(event, (payload: any) => {
			const line = `${new Date().toISOString()} [${event}] ${JSON.stringify(payload)}\n`;
			try {
				appendFileSync(LOG_PATH, line);
			} catch {
				// Log dir may not exist on first write
			}
		});
	}
}

const STATE_PATH = `${DATA_DIR}/daemon-state.json`;

let server: ReturnType<typeof startGateway> | null = null;
let pool: AgentPool | null = null;
let mesh: VesselMesh | null = null;

/** Save active session IDs to disk so they can be resumed after restart */
function saveState(): void {
	if (!pool) return;
	try {
		const state = {
			savedAt: new Date().toISOString(),
			sessions: pool.getActiveSessions(),
		};
		const data = JSON.stringify(state, null, 2);
		// Sync write - we're shutting down, can't afford async
		require("node:fs").writeFileSync(STATE_PATH, data);
		console.log(`[daemon] saved ${state.sessions.length} session(s) to disk`);
	} catch (err) {
		console.error("[daemon] failed to save state:", err);
	}
}

async function shutdown(signal: string): Promise<void> {
	console.log(`\n[daemon] received ${signal}, shutting down...`);
	saveState();
	stopHeartbeat();
	stopCron();
	if (mesh) {
		await mesh.stop().catch(() => {});
		mesh = null;
	}
	if (server) {
		server.stop();
		server = null;
	}
	pool = null;
	bus.clear();
	console.log("[daemon] stopped");
	process.exit(0);
}

/**
 * Detect local-mode flag. CLI: `bun run packages/daemon/index.ts --local`.
 * Also honors EIGHT_DAEMON_LOCAL=1 set by the canonical launcher.
 */
function isLocalMode(argv: string[]): boolean {
	if (process.env.EIGHT_DAEMON_LOCAL === "1") return true;
	return argv.includes("--local");
}

export async function main(): Promise<void> {
	const localMode = isLocalMode(process.argv.slice(2));
	if (localMode) {
		// Set both env vars so child modules (gateway, telegram-bridge,
		// dispatch) can branch on a single signal without re-parsing argv.
		process.env.EIGHT_DAEMON_LOCAL = "1";
		// Lock the WebSocket gateway to loopback. The gateway already reads
		// DAEMON_HOSTNAME, so this is the only knob we need to flip.
		if (!process.env.DAEMON_HOSTNAME) {
			process.env.DAEMON_HOSTNAME = "127.0.0.1";
		}
	}

	const config = await loadConfig();
	const poolConfig = await loadPoolConfig();

	if (localMode) {
		console.log("[daemon-local] starting in local mode (loopback only)");
	}
	console.log("[daemon] Eight Daemon starting...");
	console.log(
		`[daemon] port=${config.port} heartbeat=${config.heartbeatEnabled} auth=${config.authToken ? "enabled" : "disabled"}`,
	);

	// Auto-resolve best free model if requested
	const modelValue = poolConfig.model || DEFAULT_MODEL;
	if (modelValue === "auto:free" || modelValue === "auto") {
		console.log("[daemon] model=auto:free - resolving best free model from OpenRouter...");
		const resolved = await resolveBestFreeModel(poolConfig.apiKey);
		poolConfig.model = resolved.id;
		poolConfig.runtime = "openrouter";
		console.log(
			`[daemon] selected: ${resolved.id} (ctx: ${resolved.contextLength}, free: ${resolved.free})`,
		);
	} else {
		console.log(`[daemon] model=${modelValue} runtime=${poolConfig.runtime || "ollama"}`);
	}

	// Load vessel context for self-awareness
	try {
		const vesselContextPath = `${import.meta.dir}/VESSEL-CONTEXT.md`;
		const vesselFile = Bun.file(vesselContextPath);
		if (await vesselFile.exists()) {
			process.env.EIGHT_VESSEL_CONTEXT = await vesselFile.text();
			console.log("[daemon] vessel context loaded (self-awareness active)");
		}
	} catch {}

	// Setup log file writer
	setupLogging();

	// Create the agent pool - manages Agent instances per session
	pool = new AgentPool(poolConfig);

	// Wire the dispatch protocol (issue #1896). Surfaces register and
	// fan results across each other; the daemon is the trusted executor.
	const dispatchRegistry = new SurfaceRegistry();
	const dispatchLedger = new DispatchLedger();
	const dispatchRateLimiter = new DispatchRateLimiter();
	const dispatchVerifier = new LocalTokenVerifier(resolveLocalDispatchSecret());
	const dispatchHub = new DispatchHub();

	// Dispatch traces flow into the Phase 4 ComputerUseTraceStore
	// (#1868). Best-effort: if the store fails to open, we log and
	// keep dispatching - audit isn't on the critical path.
	let traceStore: ComputerUseTraceStore | null = null;
	try {
		traceStore = new ComputerUseTraceStore(defaultTraceDbPath());
	} catch (err) {
		console.warn(`[daemon] trace store unavailable: ${err instanceof Error ? err.message : err}`);
	}

	const dispatchExecutor: DispatchExecutor = {
		async executeOnChannel(targetChannel, intent, meta) {
			const sessionId = `disp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			pool!.createSession(sessionId, targetChannel as DaemonChannel);
			pool!
				.chat(sessionId, intent)
				.then(() => bus.emit("session:end", { sessionId, reason: "turn-complete" }))
				.catch((err) =>
					bus.emit("agent:error", {
						sessionId,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			return { sessionId };
		},
	};
	const dispatchRouter = new DispatchRouter({
		registry: dispatchRegistry,
		ledger: dispatchLedger,
		rateLimiter: dispatchRateLimiter,
		verifier: dispatchVerifier,
		executor: dispatchExecutor,
		hub: dispatchHub,
		onTrace: traceStore
			? (record) => {
					try {
						const traceId = traceStore!.startTrace({
							sessionId: record.correlationId,
							channel: record.targetChannel,
							intent: record.intentPreview,
							originatingChannel: record.originatingChannel,
							dispatchSource: record.dispatchSource,
							dispatchId: record.dispatchId,
						});
						traceStore!.closeTrace(traceId, {
							outcome: record.result === "allowed" ? "ok" : "error",
							summary: record.reason ?? null,
						});
					} catch (err) {
						console.warn(
							`[daemon] dispatch trace write failed: ${err instanceof Error ? err.message : err}`,
						);
					}
				}
			: undefined,
	});

	// Goal-loop manager. Scaffold-stage factory rejects start requests until
	// the executor/judge provider wiring is delivered by 8EO. The RPC surface
	// is live so clients can probe goal.status / goal.resume without crashing
	// the daemon, and goal.start returns a clear error rather than a 404.
	const goalFactory: GoalExecutorFactory = {
		async build() {
			throw new Error(
				"goal-loop executor factory not wired yet (issue #2606 scaffold ships RPC + types; executor binding is the follow-up issue)",
			);
		},
	};
	// Scaffold-stage event sink: log line per event so daemon operators can
	// see goal-loop traffic. Per-surface streaming + SQLite mirror (8GO) and
	// receipt emission to the bus (8DO) plug in via separate listeners in
	// follow-up issues - keeping the scaffold listener trivial avoids
	// committing to a particular bus event shape.
	const goalManager = new GoalManager({
		factory: goalFactory,
		onEvent: (event) => {
			try {
				appendFileSync(
					LOG_PATH,
					`${new Date(event.ts).toISOString()} [goal:${event.kind}] runId=${event.runId} seq=${event.seq} ${JSON.stringify(event.payload)}\n`,
				);
			} catch {
				// log dir may not exist yet
			}
		},
	});

	// Start WebSocket gateway with agent pool + dispatch + goal-loop
	server = startGateway({
		port: config.port,
		authToken: config.authToken,
		pool,
		dispatch: {
			registry: dispatchRegistry,
			router: dispatchRouter,
			ledger: dispatchLedger,
			rateLimiter: dispatchRateLimiter,
			verifier: dispatchVerifier,
			hub: dispatchHub,
		},
		goal: goalManager,
	});

	// Start heartbeat
	startHeartbeat({
		intervalMs: config.heartbeatIntervalMs,
		enabled: config.heartbeatEnabled,
	});

	// Start cron scheduler
	await startCron();

	// Auto-register daily CEO summary if not present
	const existingJobs = getJobs();
	if (!existingJobs.find((j: any) => j.id === "daily-ceo-summary")) {
		addJob({
			id: "daily-ceo-summary",
			name: "CEO Daily Summary",
			expression: "0 9 * * *",
			type: "agent-prompt",
			payload:
				"Generate a brief daily summary: list completed tasks, open PRs, and any pending work from the task registry at ~/.8gent/tasks.json",
			enabled: true,
			lastRun: null,
			nextRun: null,
			recurring: true,
		});
		console.log("[daemon] registered daily CEO summary cron (9 AM)");
	}

	console.log(`[daemon] ready - ws://localhost:${config.port}`);
	console.log(`[daemon] health check: http://localhost:${config.port}/health`);

	if (localMode) {
		console.log(`[daemon-local] listening on ws://127.0.0.1:${config.port}`);
		// Auto-start the local Telegram bridge when explicitly opted in.
		// Gated on EIGHT_TELEGRAM_LOCAL so users running TUI-only sessions
		// don't pay the cost of a bot poller they don't need.
		if (process.env.EIGHT_TELEGRAM_LOCAL === "1") {
			try {
				const { startLocalTelegramBridge } = await import("./telegram-bridge");
				await startLocalTelegramBridge({ port: config.port });
				console.log("[daemon-local] telegram bridge attached");
			} catch (err) {
				console.error("[daemon-local] telegram bridge failed:", err);
			}
		}
	}

	// Lotus-Class Compute — peer mesh. OFF by default. Internal-only during spike.
	// In local mode we never register with the remote mesh even if the env var
	// leaks through, because the daemon is loopback-only.
	if (process.env.GROVE_ENABLED === "1" && !localMode) {
		const vesselId = process.env.VESSEL_ID || `local-${require("node:os").hostname()}`;
		const vesselUrl = process.env.VESSEL_URL || `ws://localhost:${config.port}`;
		const vesselRegion = process.env.VESSEL_REGION || "local";
		const vesselName = process.env.VESSEL_NAME || vesselId;

		mesh = new VesselMesh({
			id: vesselId,
			name: vesselName,
			url: vesselUrl,
			ownerId: process.env.VESSEL_OWNER || "8gi-foundation",
			capabilities: ["code", "inference", poolConfig.runtime || "ollama"],
			model: poolConfig.model || DEFAULT_MODEL,
			region: vesselRegion,
			startedAt: Date.now(),
			activeSessions: 0,
			maxSessions: 10,
		});

		mesh.onTask(async (task: TaskPayload, from: string): Promise<TaskResult> => {
			const start = Date.now();
			if (!pool) {
				return {
					status: "failed",
					output: "",
					durationMs: Date.now() - start,
					error: "agent pool unavailable",
				};
			}
			try {
				const sessionId = `grove_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
				pool.createSession(sessionId, "api");
				const output = await pool.chat(sessionId, task.prompt);
				pool.destroySession(sessionId);
				return {
					status: "completed",
					output: typeof output === "string" ? output : JSON.stringify(output),
					durationMs: Date.now() - start,
				};
			} catch (err) {
				return {
					status: "failed",
					output: "",
					durationMs: Date.now() - start,
					error: String(err),
				};
			}
		});

		await mesh.start();
		console.log(`[daemon] grove mesh started - vesselId=${vesselId} region=${vesselRegion}`);
	}

	// Graceful shutdown
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("[daemon] fatal:", err);
		process.exit(1);
	});
}
