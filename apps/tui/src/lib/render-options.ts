import type { RenderOptions } from "ink";

/**
 * How the TUI hands frames to the terminal (#4970).
 *
 * Ink's default writer erases every row of the last frame and writes the
 * whole frame again, about 14 times a second while 8gent works: on a 52x30
 * phone that blanked 405 rows a second and sent 33 KB/s, which a terminal
 * that paints between bytes shows as a strobe. Incremental rendering moves
 * the cursor over unchanged rows and rewrites only the rows that changed.
 *
 * 8GENT_FULL_REDRAW=1 restores Ink's full repaint, for a terminal that
 * mis-tracks the cursor.
 */
export function tuiRenderOptions(env: NodeJS.ProcessEnv = process.env): RenderOptions {
	return { incrementalRendering: env["8GENT_FULL_REDRAW"] !== "1" };
}
