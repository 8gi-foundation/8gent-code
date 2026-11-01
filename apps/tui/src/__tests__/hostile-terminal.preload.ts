/**
 * Preload for hostile-terminal.test.ts. The child's stdio are pipes (the
 * sandboxed CI and dev shells cannot open a pty), so this makes the process
 * believe it has a terminal: stdin.isTTY with a no-op setRawMode, stdout.isTTY
 * with the size the test asks for. H_COLS / H_ROWS of "none" leave the size
 * undefined, as a terminal that reports no size does.
 */
const so = process.stdout as unknown as Record<string, unknown>;
const si = process.stdin as unknown as Record<string, unknown>;
si.isTTY = true;
si.isRaw = false;
si.setRawMode = (m: boolean) => {
	si.isRaw = m;
	return si;
};
so.isTTY = true;
const { H_COLS: c, H_ROWS: r } = process.env;
if (c !== "none") so.columns = Number(c ?? 100);
if (r !== "none") so.rows = Number(r ?? 30);
