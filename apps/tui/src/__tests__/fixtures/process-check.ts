/**
 * Pid checks for the quit tests. By pid only, never by name: a test may only
 * look at, and only signal, a pid it recorded from a command it started.
 */

/** Running: the process exists and is not a zombie (no one may have reaped it yet). */
export function running(pid: number): boolean {
	const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
	const stat = r.stdout.toString().trim();
	return stat !== "" && !stat.startsWith("Z");
}

export async function allGone(pids: number[], ms: number): Promise<number[]> {
	const end = Date.now() + ms;
	let left = pids.filter(running);
	while (left.length > 0 && Date.now() < end) {
		await Bun.sleep(50);
		left = left.filter(running);
	}
	return left;
}
