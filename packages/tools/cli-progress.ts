/**
 * Sets the characters used for the progress bar.
 * @param filled - Character for filled portion
 * @param empty - Character for empty portion
 */
export function style(filled: string, empty: string): void {
    _filled = filled;
    _empty = empty;
}

/**
 * Renders a progress bar string.
 * @param percent - Progress percentage (0-1)
 * @param width - Bar width (default 10)
 * @param label - Optional label
 * @returns Formatted progress bar string
 */
export function render(percent: number, width: number = 10, label?: string): string {
    const filled = Math.max(0, Math.min(width, Math.floor(percent * width)));
    const empty = width - filled;
    const bar = _filled.repeat(filled) + _empty.repeat(empty);
    const percentStr = `${Math.round(percent * 100)}%`;
    const labelPart = label ? ` ${label}` : '';
    return `[${bar}] ${percentStr}${labelPart}`;
}

/**
 * Renders ETA estimate.
 * @param percent - Progress percentage (0-1)
 * @param elapsed - Elapsed time in seconds
 * @returns ETA string or empty string
 */
export function renderETA(percent: number, elapsed: number): string {
    if (percent <= 0) return '';
    const remaining = (elapsed / percent) * (1 - percent);
    return `ETA: ${Math.round(remaining)}s`;
}

// Internal state
let _filled = '#';
let _empty = '-';