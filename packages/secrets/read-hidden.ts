/** Read one line from the terminal with echo off (or from a pipe). The value is never printed. */
export async function readHidden(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const c of stdin) chunks.push(c as Buffer);
		return Buffer.concat(chunks).toString("utf-8").split(/\r?\n/)[0] ?? "";
	}
	process.stderr.write(prompt);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	return await new Promise<string>((resolve) => {
		let buf = "";
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n" || ch === "\u0004") {
					stdin.setRawMode(false);
					stdin.pause();
					stdin.off("data", onData);
					process.stderr.write("\n");
					return resolve(buf);
				}
				if (ch === "\u0003") {
					stdin.setRawMode(false);
					process.stderr.write("\n");
					process.exit(130);
				}
				if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
				else buf += ch;
			}
		};
		stdin.on("data", onData);
	});
}
