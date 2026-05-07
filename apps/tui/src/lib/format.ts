/**
 * Formatting utilities for terminal display.
 * Pure functions, no dependencies on React or Ink.
 */

/** Format a token count with K/M/B suffixes. */
export function formatTokens(count: number): string {
	if (count < 0) return "0";
	if (count < 1000) return String(Math.round(count));
	if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${(count / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

/** Format a duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number): string {
	if (ms < 0) ms = 0;

	const totalSeconds = Math.floor(ms / 1000);

	if (totalSeconds < 1) {
		return ms < 10 ? "0ms" : `${Math.round(ms)}ms`;
	}

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	if (minutes > 0) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}

	// Under 10 seconds: show one decimal
	if (totalSeconds < 10) {
		return `${(ms / 1000).toFixed(1)}s`;
	}

	return `${seconds}s`;
}

/**
 * Format an elapsed-since-mount duration for the bottom-HUD SESSION
 * card. Distinct from `formatDuration` because the contract is fixed
 * by spec (#2367):
 *   <60s:  "Ns"
 *   <60m:  "Nm Ss"
 *   <24h:  "Hh Mm"
 *   >=24h: "Dd Hh"
 *
 * Always reports the elapsed delta from the timestamp the TUI captured
 * at mount; resets on every TUI restart by design (no persistence).
 */
export function formatSessionTime(elapsedMs: number): string {
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = 0;
	const totalSeconds = Math.floor(elapsedMs / 1000);

	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = totalSeconds % 60;
		return `${totalMinutes}m ${seconds}s`;
	}

	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const minutes = totalMinutes % 60;
		return `${totalHours}h ${minutes}m`;
	}

	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}d ${hours}h`;
}

/** Format a value/total as a percentage string. */
export function formatPercentage(value: number, total: number): string {
	if (total <= 0) return "0%";
	const pct = Math.round((value / total) * 100);
	return `${clampPct(pct)}%`;
}

function clampPct(n: number): number {
	if (n < 0) return 0;
	if (n > 100) return 100;
	return n;
}

/** Format bytes to a human-readable string. */
export function formatBytes(bytes: number): string {
	if (bytes < 0) bytes = 0;
	if (bytes === 0) return "0 B";

	const units = ["B", "KB", "MB", "GB", "TB"];
	let unitIndex = 0;
	let value = bytes;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	if (unitIndex === 0) return `${Math.round(value)} B`;
	return `${value.toFixed(1).replace(/\.0$/, "")} ${units[unitIndex]}`;
}

/** Format a Date as a relative time string ("just now", "2m ago", "1h ago", "3d ago"). */
export function formatRelativeTime(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();

	if (diffMs < 0) return "just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return "just now";

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;

	const years = Math.floor(days / 365);
	return `${years}y ago`;
}
