/**
 * Wrap a one-line system notice for a narrow column: words stay whole, a token
 * wider than the column (a path, a model id) breaks after a seam ("/", "-",
 * "_", ":", ".") and never in the middle of a word, and no row starts with a
 * space. The same function gives the row count, so the estimate and the draw agree.
 */
export function wrapNotice(text: string, width: number): string[] {
	const w = Math.max(8, width);
	const rows: string[] = [];
	let row = "";
	const push = () => {
		if (row) rows.push(row);
		row = "";
	};
	for (const word of text.split(/\s+/).filter(Boolean)) {
		let rest = word;
		while (rest.length > w) {
			const room = row ? w - row.length - 1 : w;
			const seams = [...rest.slice(0, Math.max(1, room)).matchAll(/[/\-_:.]/g)];
			const cut = seams.length ? seams[seams.length - 1].index + 1 : 0;
			if (row && cut === 0) {
				push();
				continue;
			}
			if (cut === 0) {
				row = rest.slice(0, w);
				rest = rest.slice(w);
				push();
				continue;
			}
			row = row ? `${row} ${rest.slice(0, cut)}` : rest.slice(0, cut);
			rest = rest.slice(cut);
			push();
		}
		if (!rest) continue;
		if (row && row.length + 1 + rest.length > w) push();
		row = row ? `${row} ${rest}` : rest;
	}
	push();
	return rows.length ? rows : [""];
}
