"use client";

import { useEffect, useState } from "react";

interface SystemHealthData {
	ast: {
		filesIndexed: number;
		totalSymbols: number;
		languages: Record<string, number>;
		topSymbols: Array<{
			name: string;
			kind: string;
			file: string;
			lines: number;
		}>;
		indexedAt: string;
	};
	board: {
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
	};
	momentum: {
		stepsCompleted: number;
		stepsPerMinute: number;
		streak: number;
	};
	evidence: {
		total: number;
		verified: number;
		failed: number;
		byType: Record<string, number>;
	};
	sessions: {
		totalSessions: number;
		liveSessions: number;
		totalTokens: number;
		totalToolCalls: number;
		models: Record<string, number>;
	};
	uptime: number;
	timestamp: string;
}

function StatCard({
	label,
	value,
	sub,
	color = "emerald",
}: {
	label: string;
	value: string | number;
	sub?: string;
	color?: string;
}) {
	const colorMap: Record<string, string> = {
		emerald: "text-emerald-400 border-emerald-500/20",
		cyan: "text-cyan-400 border-cyan-500/20",
		amber: "text-amber-400 border-amber-500/20",
		purple: "text-purple-400 border-purple-500/20",
		blue: "text-blue-400 border-blue-500/20",
		red: "text-red-400 border-red-500/20",
	};
	const c = colorMap[color] || colorMap.emerald;

	return (
		<div
			className={`border ${c.split(" ")[1]} rounded-lg p-3 animate-fadeIn`}
			style={{ background: "var(--surface)" }}
		>
			<div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--muted)" }}>
				{label}
			</div>
			{/* Stat-card value uses 700 weight as the locked dashboard style. */}
			{/* react-doctor-disable-next-line react-doctor/design-no-bold-heading */}
			<div className={`text-2xl font-bold ${c.split(" ")[0]}`}>{value}</div>
			{sub && (
				<div className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>
					{sub}
				</div>
			)}
		</div>
	);
}

function KanbanColumn({
	title,
	count,
	items,
	color,
}: {
	title: string;
	count: number;
	items?: Array<{
		description: string;
		category?: string;
		confidence?: number;
	}>;
	color: string;
}) {
	const dotColors: Record<string, string> = {
		zinc: "bg-zinc-500",
		amber: "bg-amber-400",
		cyan: "bg-cyan-400",
		emerald: "bg-emerald-400",
	};

	return (
		<div className="flex-1 min-w-0">
			<div className="flex items-center gap-1.5 mb-2">
				<div className={`w-2 h-2 rounded-full ${dotColors[color] || dotColors.zinc}`} />
				<span
					className="text-[10px] uppercase tracking-wider"
					style={{ color: "var(--foreground)" }}
				>
					{title}
				</span>
				<span className="text-[10px] ml-auto" style={{ color: "var(--muted)" }}>
					{count}
				</span>
			</div>
			<div className="space-y-1">
				{items && items.length > 0 ? (
					items.slice(0, 3).map((item, i) => (
						// Items come from a static-per-render snapshot; description+index is stable for this snapshot.
						// react-doctor-disable-next-line react-doctor/no-array-index-as-key
						<div
							key={`${item.description}-${i}`}
							className="rounded px-2 py-1.5 text-[10px]"
							style={{
								background: "var(--surface-hover)",
								color: "var(--foreground)",
							}}
						>
							<div className="truncate">{item.description}</div>
							{item.confidence !== undefined && (
								<div className="mt-0.5" style={{ color: "var(--muted)" }}>
									{item.category} · {Math.round(item.confidence * 100)}%
								</div>
							)}
						</div>
					))
				) : (
					<div
						className="rounded px-2 py-3 text-center text-[10px]"
						style={{ background: "var(--surface)", color: "var(--muted)" }}
					>
						{count === 0 ? "empty" : `${count} items`}
					</div>
				)}
			</div>
		</div>
	);
}

function ProgressBar({
	value,
	max,
	color = "emerald",
}: { value: number; max: number; color?: string }) {
	const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
	const barColors: Record<string, string> = {
		emerald: "bg-emerald-500",
		cyan: "bg-cyan-500",
		amber: "bg-amber-500",
		red: "bg-red-500",
	};

	return (
		<div className="w-full rounded-full h-1.5" style={{ background: "var(--surface-hover)" }}>
			<div
				className={`h-full rounded-full transition-all duration-500 ${barColors[color] || barColors.emerald}`}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatNumber(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

function HealthHeader({ uptime, lastRefresh }: { uptime: number; lastRefresh: number }) {
	// Time-since-refresh is intrinsically client-only; suppress hydration mismatch on the parent span.
	return (
		<div className="flex items-center justify-between">
			<div className="flex items-center gap-3">
				<h2 className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
					System Health
				</h2>
				<span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 animate-pulse">
					LIVE
				</span>
			</div>
			<span className="text-[10px]" style={{ color: "var(--muted)" }} suppressHydrationWarning>
				uptime: {formatUptime(uptime)} &middot; refreshed{" "}
				{Math.round((Date.now() - lastRefresh) / 1000)}s ago
			</span>
		</div>
	);
}

function TopStatsRow({ data }: { data: SystemHealthData }) {
	return (
		<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
			<StatCard
				label="Files Indexed"
				value={data.ast.filesIndexed}
				sub={`${data.ast.totalSymbols} symbols`}
				color="cyan"
			/>
			<StatCard
				label="Sessions"
				value={data.sessions.totalSessions}
				sub={`${data.sessions.liveSessions} live`}
				color="emerald"
			/>
			<StatCard
				label="Total Tokens"
				value={formatNumber(data.sessions.totalTokens)}
				sub="across sessions"
				color="amber"
			/>
			<StatCard
				label="Tool Calls"
				value={formatNumber(data.sessions.totalToolCalls)}
				color="purple"
			/>
			<StatCard
				label="Steps Done"
				value={data.momentum.stepsCompleted}
				sub={`${data.momentum.stepsPerMinute.toFixed(1)}/min`}
				color="blue"
			/>
			<StatCard label="Streak" value={data.momentum.streak} sub="consecutive" color="emerald" />
		</div>
	);
}

function KanbanBoardSection({ board }: { board: SystemHealthData["board"] }) {
	return (
		<div>
			<h3 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--muted)" }}>
				Proactive Planner: Kanban Board
			</h3>
			<div className="flex gap-3">
				<KanbanColumn title="Backlog" count={board.backlog} color="zinc" />
				<KanbanColumn title="Ready" count={board.ready} items={board.readyItems} color="amber" />
				<KanbanColumn title="In Progress" count={board.inProgress} color="cyan" />
				<KanbanColumn title="Done" count={board.done} items={board.doneItems} color="emerald" />
			</div>
		</div>
	);
}

function EvidenceSection({
	evidence,
	rate,
}: { evidence: SystemHealthData["evidence"]; rate: number }) {
	return (
		<div
			className="rounded-lg p-4"
			style={{
				background: "var(--surface)",
				border: "1px solid var(--border)",
			}}
		>
			<h3 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--muted)" }}>
				Evidence Collection
			</h3>
			<div className="flex items-center gap-4 mb-3">
				<div>
					{/* react-doctor-disable-next-line react-doctor/design-no-bold-heading */}
					<span className="text-3xl font-bold text-emerald-400">{evidence.verified}</span>
					<span className="text-lg" style={{ color: "var(--muted)" }}>
						/{evidence.total}
					</span>
				</div>
				<div className="flex-1">
					<div className="text-[10px] mb-1" style={{ color: "var(--muted)" }}>
						Verification rate: {rate}%
					</div>
					<ProgressBar value={evidence.verified} max={evidence.total || 1} color="emerald" />
				</div>
			</div>
			{evidence.failed > 0 && (
				<div className="text-[10px] text-red-400/60 mt-1">
					{evidence.failed} failed verification
					{evidence.failed !== 1 ? "s" : ""}
				</div>
			)}
			{Object.keys(evidence.byType).length > 0 && (
				<div className="mt-3 flex flex-wrap gap-1">
					{Object.entries(evidence.byType).map(([type, count]) => (
						<span
							key={type}
							className="text-[9px] px-1.5 py-0.5 rounded"
							style={{
								background: "var(--surface-hover)",
								color: "var(--muted)",
							}}
						>
							{type}: {count}
						</span>
					))}
				</div>
			)}
			{evidence.total === 0 && (
				<div className="text-[10px] mt-2" style={{ color: "var(--muted)" }}>
					No evidence collected yet. Run tasks to see verification data.
				</div>
			)}
		</div>
	);
}

function AstIndexSection({ ast }: { ast: SystemHealthData["ast"] }) {
	return (
		<div
			className="rounded-lg p-4"
			style={{
				background: "var(--surface)",
				border: "1px solid var(--border)",
			}}
		>
			<h3 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--muted)" }}>
				AST Index
			</h3>
			<div className="flex gap-4 mb-3">
				{Object.entries(ast.languages).map(([lang, count]) => (
					<div key={lang} className="flex items-center gap-1.5">
						<div
							className={`w-2 h-2 rounded-full ${lang === "typescript" ? "bg-blue-400" : "bg-yellow-400"}`}
						/>
						<span className="text-[10px]" style={{ color: "var(--foreground)" }}>
							{lang}
						</span>
						<span className="text-[10px]" style={{ color: "var(--muted)" }}>
							{count}
						</span>
					</div>
				))}
			</div>
			{ast.topSymbols.length > 0 && (
				<div className="space-y-1 mt-2">
					<div className="text-[10px] mb-1" style={{ color: "var(--muted)" }}>
						Notable symbols:
					</div>
					{ast.topSymbols.slice(0, 6).map((sym) => (
						<div
							key={`${sym.file}::${sym.kind}::${sym.name}`}
							className="flex items-center gap-2 text-[10px]"
						>
							<span
								className={`px-1 rounded ${sym.kind === "class" ? "bg-purple-500/20 text-purple-400" : "bg-cyan-500/20 text-cyan-400"}`}
							>
								{sym.kind}
							</span>
							<span style={{ color: "var(--foreground)" }}>{sym.name}</span>
							<span className="truncate ml-auto" style={{ color: "var(--muted)" }}>
								{sym.file}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function ModelDistributionSection({
	models,
}: { models: SystemHealthData["sessions"]["models"] }) {
	if (Object.keys(models).length === 0) return null;
	return (
		<div
			className="rounded-lg p-4"
			style={{
				background: "var(--surface)",
				border: "1px solid var(--border)",
			}}
		>
			<h3 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--muted)" }}>
				Model Usage
			</h3>
			<div className="flex flex-wrap gap-2">
				{Object.entries(models)
					.sort((a, b) => b[1] - a[1])
					.map(([model, count]) => (
						<div
							key={model}
							className="flex items-center gap-2 rounded px-2 py-1"
							style={{ background: "var(--surface-hover)" }}
						>
							<span className="text-[10px] text-amber-400">{model}</span>
							<span className="text-[10px]" style={{ color: "var(--muted)" }}>
								{count} session{count !== 1 ? "s" : ""}
							</span>
						</div>
					))}
			</div>
		</div>
	);
}

function InfrastructurePillarsSection({ ast }: { ast: SystemHealthData["ast"] }) {
	const pillars = [
		{
			name: "AST-First Retrieval",
			status: ast.filesIndexed > 0,
			detail: `${ast.filesIndexed} files`,
		},
		{ name: "BMAD Planning", status: true, detail: "Universal (5 types)" },
		{ name: "Multi-Agent Orchestration", status: true, detail: "Pool + Subagents" },
		{ name: "Evidence Validation", status: true, detail: "Fire-and-forget" },
	];
	return (
		<div
			className="rounded-lg p-4"
			style={{
				background: "var(--surface)",
				border: "1px solid var(--border)",
			}}
		>
			<h3 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--muted)" }}>
				Infrastructure Pillars
			</h3>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
				{pillars.map((pillar) => (
					<div key={pillar.name} className="flex items-center gap-2">
						<div
							className={`w-2 h-2 rounded-full ${pillar.status ? "bg-emerald-400" : "bg-red-400"}`}
						/>
						<div>
							<div className="text-[10px]" style={{ color: "var(--foreground)" }}>
								{pillar.name}
							</div>
							<div className="text-[9px]" style={{ color: "var(--muted)" }}>
								{pillar.detail}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export default function SystemHealth() {
	const [data, setData] = useState<SystemHealthData | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Lazy init so Date.now() runs once at mount, not on every re-render.
	const [lastRefresh, setLastRefresh] = useState<number>(() => Date.now());

	// Polls /api/system-health every 5s; route reads live filesystem state, RSC equivalent gains nothing here.
	// Three setStates per tick reflect the {data, error, refreshTimestamp} polling guard.
	// react-doctor-disable-next-line react-doctor/no-fetch-in-effect
	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		const fetchHealth = () => {
			fetch("/api/system-health")
				.then((r) => r.json())
				.then((d) => {
					setData(d);
					setError(null);
					setLastRefresh(Date.now());
				})
				.catch((e) => setError(String(e)));
		};

		fetchHealth();
		const interval = setInterval(fetchHealth, 5000);
		return () => clearInterval(interval);
	}, []);

	if (error) {
		return (
			<div className="flex items-center justify-center h-full text-red-400 text-sm">
				Failed to load system health: {error}
			</div>
		);
	}

	if (!data) {
		return (
			<div
				className="flex items-center justify-center h-full text-sm animate-pulse"
				style={{ color: "var(--muted)" }}
			>
				Loading system health&hellip;
			</div>
		);
	}

	const evidenceRate =
		data.evidence.total > 0 ? Math.round((data.evidence.verified / data.evidence.total) * 100) : 0;

	return (
		<div className="h-full overflow-y-auto p-4 space-y-6">
			<HealthHeader uptime={data.uptime} lastRefresh={lastRefresh} />
			<TopStatsRow data={data} />
			<KanbanBoardSection board={data.board} />
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				<EvidenceSection evidence={data.evidence} rate={evidenceRate} />
				<AstIndexSection ast={data.ast} />
			</div>
			<ModelDistributionSection models={data.sessions.models} />
			<InfrastructurePillarsSection ast={data.ast} />
		</div>
	);
}
