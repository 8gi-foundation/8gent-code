/**
 * Stale-output handles (#3477), behind EIGHT_OBSERVATION_PACK=1 (exactly "1"),
 * on the text-tool path. Concept from SoL-Pi's ObservationPack (arXiv
 * 2609.20519); no code taken.
 *
 * A tool-result message over PACK_MIN_BYTES is sent whole for PACK_WINDOW
 * model requests, then replaced by a stub: size, handle, head and tail. The
 * full text is saved once through the #3474 result store (0600 file in a 0700
 * dir under the session's own dir) and read back exactly with read_output.
 *
 * Prefix stability: a message is packed once, its stub is cached, and every
 * later request sends the same stub bytes. The prefix changes only on the one
 * request where a message crosses the window. No model calls, no dependencies.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TextTool } from "../ai/text-tool-loop";
import { storeResult } from "../mcp/lean";

export const PACK_WINDOW = 2;
export const PACK_MIN_BYTES = 10 * 1024;
const HEAD = 400;
const TAIL = 400;
const READ_DEFAULT = 4000;
const READ_MAX = 8000;
// How runTextToolAgent labels a round's tool results (packages/ai/text-tool-loop.ts).
const TOOL_RESULT = /^Tool \S+ returned:\n/;

export function observationPackEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.EIGHT_OBSERVATION_PACK === "1";
}

/** Saved outputs for one session. Only handles made here can be read back. */
export class ObservationStore {
	private paths = new Map<string, string>();
	constructor(private readonly sessionDir: string) {}

	save(text: string): { handle: string; path: string } {
		const saved = storeResult(text, this.sessionDir);
		this.paths.set(saved.handle, saved.path);
		return saved;
	}

	/** The exact saved text, or a character range of it. Throws on an unknown handle. */
	read(handle: string, offset = 0, limit = Number.POSITIVE_INFINITY): string {
		const path = this.paths.get(handle);
		if (!path) throw new Error(`no saved output with handle "${handle}" in this session`);
		return readFileSync(path, "utf8").slice(offset, offset + limit);
	}

	size(handle: string): number {
		return this.read(handle).length;
	}
}

type Message = { role: string; content: string };

export class ObservationPacker {
	private request = 0;
	private firstSeen = new Map<string, number>();
	private stubs = new Map<string, string>();
	private failed = new Set<string>();
	private readonly window: number;
	private readonly minBytes: number;

	constructor(
		private readonly store: ObservationStore,
		opts: { window?: number; minBytes?: number } = {},
	) {
		this.window = opts.window ?? PACK_WINDOW;
		this.minBytes = opts.minBytes ?? PACK_MIN_BYTES;
	}

	/** Call once per model request. Returns a new array; the input is never mutated. */
	pack<M extends Message>(msgs: M[]): M[] {
		this.request++;
		return msgs.map((m, i) => {
			if (m.role !== "user" || !TOOL_RESULT.test(m.content)) return m;
			if (Buffer.byteLength(m.content, "utf8") <= this.minBytes) return m;
			// Position plus content: a later identical result is its own message.
			const key = `${i}:${createHash("sha256").update(m.content).digest("hex")}`;
			const cached = this.stubs.get(key);
			if (cached !== undefined) return { ...m, content: cached };
			if (this.failed.has(key)) return m;
			const first = this.firstSeen.get(key) ?? this.request;
			this.firstSeen.set(key, first);
			if (this.request - first < this.window) return m;
			let stub: string;
			try {
				const { handle, path } = this.store.save(m.content);
				stub = stubFor(m.content, handle, path);
			} catch {
				// Could not save: keep the whole result rather than lose it.
				this.failed.add(key);
				return m;
			}
			this.stubs.set(key, stub);
			return { ...m, content: stub };
		});
	}
}

function stubFor(text: string, handle: string, path: string): string {
	return [
		`[Earlier tool output packed to save context: ${text.length} chars (${Buffer.byteLength(text, "utf8")} bytes), handle ${handle}, full copy at ${path}]`,
		`Head (first ${HEAD} chars):`,
		text.slice(0, HEAD),
		"...",
		`Tail (last ${TAIL} chars):`,
		text.slice(-TAIL),
		`[To read it back exactly: read_output {"handle":"${handle}","offset":0,"limit":${READ_DEFAULT}}. Offset and limit count characters, limit at most ${READ_MAX}.]`,
	].join("\n");
}

/** The read_output text tool: a character range of a packed output, by handle. */
export function readOutputTool(store: ObservationStore): TextTool {
	return {
		spec: {
			name: "read_output",
			description:
				"Read back an earlier tool output that was packed to save context, exactly as it was, by its handle. Use offset and limit (characters) to read it in parts.",
			parameters: {
				type: "object",
				properties: {
					handle: { type: "string", description: "The handle from the packed-output note." },
					offset: { type: "integer", description: "First character to read (default 0)." },
					limit: {
						type: "integer",
						description: `Characters to read (default ${READ_DEFAULT}, max ${READ_MAX}).`,
					},
				},
				required: ["handle"],
			},
		},
		run: async (args) => {
			const handle = typeof args.handle === "string" ? args.handle : "";
			const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
			const want = Math.floor(Number(args.limit ?? READ_DEFAULT)) || READ_DEFAULT;
			const limit = Math.min(Math.max(1, want), READ_MAX);
			let total: number;
			let part: string;
			try {
				total = store.size(handle);
				part = store.read(handle, offset, limit);
			} catch (err) {
				return `Error: ${err instanceof Error ? err.message : String(err)}`;
			}
			const end = offset + part.length;
			const more = end < total ? `, next offset ${end}` : ", end of output";
			return `[read_output ${handle}: chars ${offset}-${end} of ${total}${more}]\n${part}`;
		},
	};
}
