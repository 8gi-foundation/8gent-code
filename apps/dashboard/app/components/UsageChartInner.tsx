"use client";

/**
 * UsageChartInner — Recharts-backed implementation of the usage chart.
 *
 * Imported via `next/dynamic` from UsageChart.tsx so that recharts is split
 * into its own JS bundle (recharts is large; lazy-loading keeps the initial
 * dashboard payload light).
 *
 * Behavior is identical to the previous single-file UsageChart — only the
 * module boundary changed.
 */

import { useState } from "react";
// This module is the lazy-loaded payload — UsageChart.tsx already wraps it in
// `next/dynamic({ ssr: false })`, so recharts is code-split out of the initial
// dashboard bundle. Importing recharts statically here is intentional.
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

interface UsageDataPoint {
	date: string;
	tokensIn: number;
	tokensOut: number;
	totalTokens: number;
	sessions: number;
	activeUsers: number;
}

interface UsageChartInnerProps {
	data: UsageDataPoint[];
	title?: string;
}

type MetricKey = "totalTokens" | "sessions" | "activeUsers";

const METRIC_CONFIG: Record<
	MetricKey,
	{ label: string; color: string; formatter: (v: number) => string }
> = {
	totalTokens: {
		label: "Tokens",
		color: "var(--8gent-accent)",
		formatter: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)),
	},
	sessions: {
		label: "Sessions",
		color: "var(--8gent-success)",
		formatter: (v) => String(v),
	},
	activeUsers: {
		label: "Active Users",
		color: "var(--8gent-warning)",
		formatter: (v) => String(v),
	},
};

export default function UsageChartInner({
	data,
	title = "Usage (Last 30 Days)",
}: UsageChartInnerProps) {
	const [metric, setMetric] = useState<MetricKey>("totalTokens");
	const config = METRIC_CONFIG[metric];

	// Format dates for display (MM/DD)
	const chartData = data.map((d) => ({
		...d,
		displayDate: `${d.date.slice(5, 7)}/${d.date.slice(8, 10)}`,
	}));

	return (
		<div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6">
			<div className="mb-4 flex items-center justify-between">
				<h3 className="text-sm font-medium text-[var(--8gent-text)]">{title}</h3>
				<div className="flex gap-1">
					{(Object.keys(METRIC_CONFIG) as MetricKey[]).map((key) => (
						<button
							key={key}
							onClick={() => setMetric(key)}
							className={`rounded px-2 py-1 text-xs transition-colors ${
								metric === key
									? "bg-[var(--8gent-accent)] text-[var(--8gent-text)]"
									: "text-[var(--8gent-text-muted)] hover:text-[var(--8gent-text-secondary)]"
							}`}
						>
							{METRIC_CONFIG[key].label}
						</button>
					))}
				</div>
			</div>
			<div className="h-64">
				<ResponsiveContainer width="100%" height="100%">
					<AreaChart data={chartData}>
						<defs>
							<linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="5%" stopColor={config.color} stopOpacity={0.3} />
								<stop offset="95%" stopColor={config.color} stopOpacity={0} />
							</linearGradient>
						</defs>
						<CartesianGrid strokeDasharray="3 3" stroke="var(--8gent-border)" vertical={false} />
						<XAxis
							dataKey="displayDate"
							tick={{ fill: "var(--8gent-text-muted)", fontSize: 11 }}
							axisLine={{ stroke: "var(--8gent-border)" }}
							tickLine={false}
							interval={Math.floor(chartData.length / 6)}
						/>
						<YAxis
							tick={{ fill: "var(--8gent-text-muted)", fontSize: 11 }}
							axisLine={false}
							tickLine={false}
							tickFormatter={config.formatter}
						/>
						<Tooltip
							contentStyle={{
								backgroundColor: "var(--8gent-bg-elevated)",
								border: "1px solid var(--8gent-border)",
								borderRadius: "6px",
								color: "var(--8gent-text)",
								fontSize: "12px",
							}}
							formatter={(value: number) => [config.formatter(value), config.label]}
							labelFormatter={(label) => `Date: ${label}`}
						/>
						<Area
							type="monotone"
							dataKey={metric}
							stroke={config.color}
							strokeWidth={2}
							fill="url(#chartGradient)"
							dot={false}
							activeDot={{ r: 4, fill: config.color }}
						/>
					</AreaChart>
				</ResponsiveContainer>
			</div>
		</div>
	);
}
