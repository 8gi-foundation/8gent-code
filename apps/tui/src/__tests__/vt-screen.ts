/**
 * A tiny terminal screen for render tests (#4970): replays what Ink wrote and
 * returns the rows a person would see. It knows only what Ink's frame writers
 * send: text, CR, LF, cursor up/down/next-line/column, erase line, erase to
 * end of line, erase display, cursor home. Colours and modes are ignored.
 * Rows that scroll off the top are dropped, as on a real terminal.
 */
export function replay(raw: string, cols: number, rows: number): string[] {
	const blank = () => Array.from({ length: cols }, () => " ");
	let screen = Array.from({ length: rows }, blank);
	let r = 0;
	let c = 0;
	const lineFeed = () => {
		if (r === rows - 1) screen = [...screen.slice(1), blank()];
		else r++;
	};
	const token =
		// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing escapes
		/\u001B\[([?0-9;]*)([@-~])|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B.|[\s\S]/gu;
	for (const m of raw.matchAll(token)) {
		const [whole, params, cmd] = m;
		if (cmd !== undefined) {
			if (params.startsWith("?")) continue;
			const n = Number(params.split(";")[0] || 0);
			if (cmd === "A") r = Math.max(0, r - (n || 1));
			else if (cmd === "B") r = Math.min(rows - 1, r + (n || 1));
			else if (cmd === "E") {
				r = Math.min(rows - 1, r + (n || 1));
				c = 0;
			} else if (cmd === "G") c = Math.max(0, (n || 1) - 1);
			else if (cmd === "H") {
				const [y, x] = params.split(";").map((v) => Number(v || 1));
				r = (y || 1) - 1;
				c = (x || 1) - 1;
			} else if (cmd === "K") {
				const row = screen[r] as string[];
				const from = n === 1 ? 0 : n === 2 ? 0 : c;
				const to = n === 1 ? c + 1 : cols;
				for (let i = from; i < to; i++) row[i] = " ";
			} else if (cmd === "J" && n === 2) screen = Array.from({ length: rows }, blank);
			continue;
		}
		if (whole.startsWith("\u001B")) continue;
		// A tty's output processing (ONLCR) turns LF into CR LF.
		if (whole === "\n") {
			c = 0;
			lineFeed();
		} else if (whole === "\r") c = 0;
		else if (whole >= " ") {
			if (c >= cols) {
				c = 0;
				lineFeed();
			}
			(screen[r] as string[])[c++] = whole;
		}
	}
	return screen.map((row) => row.join("").trimEnd());
}
