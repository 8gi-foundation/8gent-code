import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PROJECT_ROOT = resolve(join(homedir(), "8gent-code"));

// Lazy-load the real parser at runtime to avoid Turbopack static analysis
type ParseResult = {
	symbols: Array<{
		name: string;
		kind: string;
		startLine: number;
		endLine: number;
	}>;
	language: string;
	filePath: string;
};
let _parser: ((filePath: string) => ParseResult) | null | undefined = undefined; // undefined = not tried yet
function getParser(): ((filePath: string) => ParseResult) | null {
	if (_parser !== undefined) return _parser;
	try {
		// createRequire bypasses Turbopack static analysis without resorting to eval.
		// The path is a fixed constant under PROJECT_ROOT, not user input.
		const requireFn = createRequire(import.meta.url);
		const mod = requireFn(join(PROJECT_ROOT, "packages/ast-index/typescript-parser"));
		_parser = mod.parseTypeScriptFile ?? null;
	} catch {
		_parser = null;
	}
	return _parser ?? null;
}

interface SymbolInfo {
	name: string;
	kind: string;
	file: string;
	lines: number;
}

interface ASTStats {
	filesIndexed: number;
	totalSymbols: number;
	languages: Record<string, number>;
	topSymbols: SymbolInfo[];
	indexedAt: string;
}

interface KanbanBoard {
	backlog: number;
	ready: number;
	inProgress: number;
	done: number;
	readyItems: Array<{
		description: string;
		category: string;
		confidence: number;
	}>;
	doneItems: Array<{ description: string; category: string }>;
}

interface Momentum {
	stepsCompleted: number;
	stepsPerMinute: number;
	streak: number;
}

interface EvidenceSummary {
	total: number;
	verified: number;
	failed: number;
	byType: Record<string, number>;
}

interface SessionStats {
	totalSessions: number;
	liveSessions: number;
	totalTokens: number;
	totalToolCalls: number;
	models: Record<string, number>;
}

interface SystemHealthData {
	ast: ASTStats;
	board: KanbanBoard;
	momentum: Momentum;
	evidence: EvidenceSummary;
	sessions: SessionStats;
	uptime: number;
	timestamp: string;
}

// AST stats using the TypeScript parser for accurate symbol counting
function getASTStats(): ASTStats {
	const stats: ASTStats = {
		filesIndexed: 0,
		totalSymbols: 0,
		languages: {},
		topSymbols: [],
		indexedAt: new Date().toISOString(),
	};

	const extensions = [".ts", ".tsx", ".js", ".jsx"];
	const ignoreDirs = new Set(["node_modules", "dist", ".git", ".next", "coverage"]);

	function walk(dir: string): void {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (ignoreDirs.has(entry.name) || entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
					// Only parse first 50 files
					if (stats.filesIndexed >= 50) {
						return;
					}

					stats.filesIndexed++;
					const name = entry.name;
					const lang =
						name.endsWith(".ts") || name.endsWith(".tsx") ? "typescript" : "javascript";
					stats.languages[lang] = (stats.languages[lang] || 0) + 1;

					try {
						const parseFile = getParser();
						if (!parseFile) {
							// Fallback: simple regex count when parser unavailable
							const content = readFileSync(full, "utf-8");
							const matches = content.match(
								/(?:export\s+)?(?:function|class|interface|type|const)\s+\w+/g,
							);
							stats.totalSymbols += matches?.length || 0;
							continue;
						}
						const outline = parseFile(full);
						const symbolCount = outline.symbols.length;
						stats.totalSymbols += symbolCount;

						// Track notable symbols (first 10 class/function symbols)
						const relFile = relative(PROJECT_ROOT, full);
						const classFuncSymbols = outline.symbols
							.filter((s) => s.kind === "class" || s.kind === "function")
							.slice(0, 10);

						for (const symbol of classFuncSymbols) {
							if (stats.topSymbols.length >= 10) break;
							stats.topSymbols.push({
								name: symbol.name,
								kind: symbol.kind,
								file: relFile,
								lines: symbol.endLine - symbol.startLine + 1,
							});
						}
					} catch {
						// skip unreadable files
					}
				}
			}
		} catch {
			// skip inaccessible dirs
		}
	}

	walk(join(PROJECT_ROOT, "packages"));
	walk(join(PROJECT_ROOT, "apps"));

	// Keep only top 10 symbols
	stats.topSymbols = stats.topSymbols.slice(0, 10);

	return stats;
}

// Read session stats from disk
async function getSessionStats(): Promise<SessionStats> {
	const sessionsDir = join(homedir(), ".8gent", "sessions");
	const stats: SessionStats = {
		totalSessions: 0,
		liveSessions: 0,
		totalTokens: 0,
		totalToolCalls: 0,
		models: {},
	};

	try {
		const files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
		stats.totalSessions = files.length;

		// Sample last 10 sessions for stats — read in parallel, merge into shared stats once each resolves.
		const recent = files.slice(-10);
		const perFile = await Promise.all(
			recent.map(async (file) => {
				const out = {
					isLive: true,
					tokens: 0,
					toolCalls: 0,
					models: [] as string[],
				};
				try {
					const content = await readFile(join(sessionsDir, file), "utf-8");
					for (const line of content.split("\n")) {
						if (!line) continue;
						try {
							const entry = JSON.parse(line);
							if (entry.type === "session_start" && entry.meta?.agent?.model) {
								out.models.push(entry.meta.agent.model);
							}
							if (entry.type === "session_end") {
								out.isLive = false;
								if (entry.summary?.totalTokens) out.tokens += entry.summary.totalTokens;
								if (entry.summary?.totalUsage?.totalTokens)
									out.tokens += entry.summary.totalUsage.totalTokens;
								if (entry.summary?.totalToolCalls)
									out.toolCalls += entry.summary.totalToolCalls;
							}
						} catch {
							/* skip malformed line */
						}
					}
				} catch {
					/* unreadable file */
				}
				return out;
			}),
		);

		for (const r of perFile) {
			if (r.isLive) stats.liveSessions++;
			stats.totalTokens += r.tokens;
			stats.totalToolCalls += r.toolCalls;
			for (const model of r.models) {
				stats.models[model] = (stats.models[model] || 0) + 1;
			}
		}
	} catch {
		/* no sessions dir */
	}

	return stats;
}

const startTime = Date.now();

export async function GET() {
	const [ast, sessions] = await Promise.all([Promise.resolve(getASTStats()), getSessionStats()]);

	// Planner state — return defaults since it's an in-memory singleton in the TUI process
	// The API shows structural readiness; live data comes from the TUI's own /board command
	const board: KanbanBoard = {
		backlog: 0,
		ready: 0,
		inProgress: 0,
		done: 0,
		readyItems: [],
		doneItems: [],
	};

	const momentum: Momentum = {
		stepsCompleted: 0,
		stepsPerMinute: 0,
		streak: 0,
	};

	const evidence: EvidenceSummary = {
		total: 0,
		verified: 0,
		failed: 0,
		byType: {},
	};

	const health: SystemHealthData = {
		ast,
		board,
		momentum,
		evidence,
		sessions,
		uptime: Date.now() - startTime,
		timestamp: new Date().toISOString(),
	};

	return NextResponse.json(health);
}
