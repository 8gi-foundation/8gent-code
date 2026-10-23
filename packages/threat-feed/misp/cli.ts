#!/usr/bin/env bun
import { defaultStoreRoot, ingest } from "./ingest";
import { CIRCL_OSINT, envKeyName, parseSourceFlag } from "./source";

const USAGE = `usage: bun packages/threat-feed/misp/cli.ts [--max-events N|all] [--source name=https://host/feed] [--out DIR]
Fetches the MISP feed manifest and the newest N events (default 25, 0 = manifest only) into the store. Read-only. No indicator matching yet.
Default source: CIRCL OSINT. A second source takes its key from ${envKeyName("<name>")} in the environment.`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
	console.log(USAGE);
	process.exit(0);
}
const vals = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
const m = vals("--max-events")[0] ?? "25";
const maxEvents = m === "all" ? Number.POSITIVE_INFINITY : Number.parseInt(m, 10);
if (Number.isNaN(maxEvents) || maxEvents < 0) {
	console.error(USAGE);
	process.exit(2);
}
const extra = vals("--source").map((s) => parseSourceFlag(s));
for (const s of extra.length ? extra : [CIRCL_OSINT]) {
	const r = await ingest(s, { maxEvents, storeRoot: vals("--out")[0] ?? defaultStoreRoot() });
	console.log(
		`${r.source}: manifest events=${r.manifestEvents} stored=${r.stored} already=${r.alreadyStored} failed=${r.failed.length}`,
	);
	console.log(`store: ${r.dir}`);
}
