"use client";

/**
 * UsageChart — Public surface for the dashboard usage chart.
 *
 * The recharts implementation lives in UsageChartInner.tsx and is loaded via
 * `next/dynamic` so the heavy chart bundle is code-split out of the initial
 * dashboard payload. Behavior matches the previous single-file UsageChart.
 */

import dynamic from "next/dynamic";

interface UsageDataPoint {
	date: string;
	tokensIn: number;
	tokensOut: number;
	totalTokens: number;
	sessions: number;
	activeUsers: number;
}

interface UsageChartProps {
	data: UsageDataPoint[];
	title?: string;
}

const UsageChartInner = dynamic(() => import("./UsageChartInner"), {
	ssr: false,
	loading: () => <UsageChartSkeleton />,
});

export function UsageChart(props: UsageChartProps) {
	return <UsageChartInner {...props} />;
}

/**
 * UsageChartSkeleton — Loading placeholder.
 */
export function UsageChartSkeleton() {
	return (
		<div className="rounded-lg border border-[var(--8gent-border)] bg-[var(--8gent-bg-elevated)] p-6 animate-pulse">
			<div className="mb-4 h-4 w-40 rounded bg-[var(--8gent-bg-hover)]" />
			<div className="h-64 rounded bg-[var(--8gent-bg-hover)]" />
		</div>
	);
}
