/**
 * Public types of the SDK entry (dist/sdk.js). Shipped as dist/sdk.d.ts by
 * scripts/build-bundles.ts. sdk-types.check.ts fails the type check when
 * packages/eight/sdk.ts drifts from this file.
 */
export type SessionEvent =
	| { type: "tool_start"; tool: string; args: Record<string, unknown> }
	| { type: "tool_end"; tool: string; result?: string }
	| { type: "text"; text: string }
	| { type: "steer"; text: string }
	| { type: "follow_up"; text: string }
	| { type: "done" }
	| { type: "error"; error: string };

export type SessionListener = (event: SessionEvent) => void;

export interface SessionOptions {
	model?: string;
	runtime?: string;
	cwd?: string;
	systemPrompt?: string;
	id?: string;
	sessionsDir?: string;
	persist?: boolean;
	maxTurns?: number;
	baseUrl?: string;
}

export interface SessionState {
	sessionId: string;
	model: string;
	provider: string;
	cwd: string;
	busy: boolean;
	queueLength: number;
	steerQueue: number;
	followUpQueue: number;
	messageCount: number;
	persisted: boolean;
}

export interface ChatMessage {
	role: string;
	content: string;
}

export class UnsupportedError extends Error {}
export class BusyError extends Error {}

export class Session {
	readonly id: string;
	readonly cwd: string;
	subscribe(listener: SessionListener): () => void;
	turn(text: string): Promise<string>;
	prompt(text: string): Promise<string>;
	steer(text: string): boolean;
	followUp(text: string): boolean;
	clearQueue(): { steers: string[]; followUps: string[] };
	abort(): { followUps: string[] };
	getState(): SessionState;
	getMessages(): ChatMessage[];
	getLastAssistantText(): string | null;
	setModel(rawModel: string): { model: string; provider: string };
	compact(): never;
	fork(opts?: { entryId?: string | null; name?: string }): Session;
	dispose(): Promise<void>;
}

export function createSession(options?: SessionOptions): Session;
export function parseModel(rawModel: string, runtimeOverride?: string): { runtime: string; model: string };
export const KNOWN_RUNTIMES: string[];
export interface SessionListItem {
	id: string;
	name?: string;
	cwd: string;
	model?: string;
	provider?: string;
	createdAt: string;
	lastActiveAt: string;
	messageCount: number;
	branch?: string;
	channel?: string;
	format: "tree" | "legacy";
	file: string;
	parentSession?: { id: string; entryId: string | null };
}
export function listSessions(opts?: {
	cwd?: string;
	limit?: number;
	sessionsDir?: string;
	includeEmpty?: boolean;
}): SessionListItem[];
