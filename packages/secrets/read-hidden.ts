/**
 * Read one line from the terminal with echo off (or from a pipe). The value is
 * never printed.
 *
 * Every way out of the prompt (Enter, Ctrl+D, Ctrl+C, the stream ending or
 * erroring, the process exiting) goes through one `restore`, so the terminal is
 * never left in raw mode with echo off (8SO, #4681). Piped input is read only up
 * to the first line break and at most MAX_PIPED_BYTES.
 */

/** No provider key is anywhere near this long; it bounds what a pipe can make us buffer. */
export const MAX_PIPED_BYTES = 64 * 1024;

type HiddenStdin = NodeJS.ReadableStream & {
	isTTY?: boolean;
	setRawMode?: (on: boolean) => unknown;
	setEncoding: (enc: BufferEncoding) => unknown;
	pause: () => unknown;
	resume: () => unknown;
};

export async function readHidden(
	prompt: string,
	io: {
		stdin?: HiddenStdin;
		stderr?: { write: (s: string) => unknown };
		exit?: (code: number) => unknown;
	} = {},
): Promise<string> {
	const stdin = io.stdin ?? (process.stdin as HiddenStdin);
	const stderr = io.stderr ?? process.stderr;
	const exit = io.exit ?? ((code: number) => process.exit(code));

	if (!stdin.isTTY) {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const c of stdin) {
			const b = typeof c === "string" ? Buffer.from(c) : (c as Buffer);
			chunks.push(b);
			size += b.length;
			if (b.includes(0x0a) || size >= MAX_PIPED_BYTES) break;
		}
		return (
			Buffer.concat(chunks).subarray(0, MAX_PIPED_BYTES).toString("utf-8").split(/\r?\n/)[0] ?? ""
		);
	}

	stderr.write(prompt);
	return await new Promise<string>((resolve, reject) => {
		let buf = "";
		let done = false;
		const restore = () => {
			if (done) return;
			done = true;
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onError);
			process.off("exit", onExit);
			try {
				stdin.setRawMode?.(false);
			} catch {
				/* stream already gone */
			}
			stdin.pause();
			stderr.write("\n");
		};
		const onExit = () => restore();
		const onEnd = () => {
			restore();
			resolve(buf);
		};
		const onError = (e: unknown) => {
			restore();
			buf = "";
			reject(e instanceof Error ? e : new Error("could not read the key from the terminal"));
		};
		const onData = (chunk: string | Buffer) => {
			for (const ch of String(chunk)) {
				if (ch === "\r" || ch === "\n" || ch === "\u0004") {
					restore();
					return resolve(buf);
				}
				if (ch === "\u0003") {
					restore();
					buf = "";
					exit(130);
					return resolve("");
				}
				if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
				else buf += ch;
			}
		};
		process.once("exit", onExit);
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdin.once("error", onError);
		stdin.setRawMode?.(true);
		stdin.setEncoding("utf8");
		stdin.resume();
	});
}
