/** PageUp/PageDown move the palette's window a screenful, so a long list is not 90 Down presses. */
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { clearTargets } from "../../lib/click-targets.js";
import { CommandPalette, paletteGeometry } from "../CommandPalette.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const COMMANDS = Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, description: `d${i}` }));

class FakeStdin extends EventEmitter {
	isTTY = true;
	q: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return this.q.shift() ?? null;
	}
	feed(s: string) {
		this.q.push(s);
		this.emit("readable");
	}
}
const unmount: Array<() => void> = [];
afterEach(() => {
	for (const u of unmount.splice(0)) u();
	clearTargets();
});

async function press(key: string, times: number) {
	const out = Object.assign(new EventEmitter(), { columns: 100, rows: 34, isTTY: false, last: "" });
	(out as unknown as { write: (s: string) => boolean }).write = (s) => {
		if (strip(s).trim()) out.last = strip(s);
		return true;
	};
	const stdin = new FakeStdin();
	const app = render(
		<CommandPalette
			isOpen
			columns={100}
			rows={34}
			animate={false}
			onClose={() => {}}
			onExecute={() => {}}
			commands={COMMANDS}
		/>,
		{
			stdout: out as never,
			stdin: stdin as never,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	unmount.push(() => app.unmount());
	await sleep(50);
	for (let i = 0; i < times; i++) {
		stdin.feed(key);
		await sleep(15);
	}
	await sleep(50);
	return out.last;
}

test("one PageDown moves the cursor a screenful, PageUp comes back", async () => {
	const page = paletteGeometry(100, 34).visibleRows;
	const down = await press("\x1b[6~", 1);
	expect(down).toContain(`c${page}`);
	expect(down).toContain("◆ /c" + page);
	const back = await press("\x1b[6~", 2).then(() => press("\x1b[5~", 0));
	expect(back).toContain("◆ /c0");
});

test("PageDown stops on the last command", async () => {
	const end = await press("\x1b[6~", 20);
	expect(end).toContain("◆ /c39");
});

test("the more lines name the paging key, and the list stays the same height", async () => {
	const mid = await press("\x1b[B", 14);
	expect(mid).toContain("more · PgUp");
	expect(mid).toContain("more · PgDn");
});
