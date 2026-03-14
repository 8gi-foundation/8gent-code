/**
 * Formatting utilities for terminal display.
 * Pure functions, no dependencies on React or Ink.
 */

/** Format a token count with K/M/B suffixes. */
export function formatTokens(count: number): string {
  if (count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  if (count < 1_000_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  return (count / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
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
    return (ms / 1000).toFixed(1) + "s";
  }

  return `${seconds}s`;
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
