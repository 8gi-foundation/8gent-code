/**
 * How much chrome the shell draws, decided from the terminal's size (#4967).
 *
 * A phone with the soft keyboard open leaves 14 to 16 rows. The full chrome
 * (brand box 3, tab row and rule 2, status box 3, frame 2, prompt 1, footer 1)
 * costs 12 of them at 52 columns and leaves the answer one row. Below
 * KEYS_UP_BELOW_ROWS rows on a narrow screen the shell folds its chrome so the
 * conversation gets the rows the keyboard left. Closing the keyboard grows the
 * rows and the roomy layout returns on the next resize. Pure; no React.
 */

export type ChromeTier = "roomy" | "keys-up";

/** Fewer rows than this on a narrow screen is a phone with the keyboard up. */
export const KEYS_UP_BELOW_ROWS = 20;
/** Wider than this is a desktop or tablet; a short window there keeps the full chrome. */
export const KEYS_UP_MAX_COLS = 60;

export function chromeTier(rows: number, cols: number): ChromeTier {
	return rows < KEYS_UP_BELOW_ROWS && cols <= KEYS_UP_MAX_COLS ? "keys-up" : "roomy";
}
