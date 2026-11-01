import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MispSource } from "./source";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MANIFEST = 50 * 1024 * 1024;
const MAX_EVENT = 25 * 1024 * 1024;

export interface ManifestEntry {
	info?: string;
	date?: string;
	timestamp?: number | string;
	threat_level_id?: number | string;
	Orgc?: { name?: string };
}

export const defaultStoreRoot = () => path.join(os.homedir(), ".8gent/security/threat-feed/misp");

export const isEventId = (s: string) => UUID_RE.test(s);

export function parseManifest(doc: unknown): Map<string, ManifestEntry> {
	if (!doc || typeof doc !== "object" || Array.isArray(doc))
		throw new Error("misp manifest: expected an object keyed by event uuid");
	const out = new Map<string, ManifestEntry>();
	for (const [id, v] of Object.entries(doc))
		if (isEventId(id)) out.set(id, (v ?? {}) as ManifestEntry);
	if (!out.size) throw new Error("misp manifest: no event uuids found");
	return out;
}

const headers = (s: MispSource): Record<string, string> => ({
	accept: "application/json",
	...(s.authKey ? { authorization: s.authKey } : {}),
});

async function getText(
	f: Fetch,
	url: string,
	s: MispSource,
	cap: number,
	what: string,
): Promise<string> {
	const res = await f(url, { headers: headers(s) });
	if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
	const text = await res.text();
	if (text.length > cap) throw new Error(`${what}: over ${cap} bytes`);
	return text;
}

export interface IngestResult {
	source: string;
	manifestEvents: number;
	stored: number;
	alreadyStored: number;
	failed: string[];
	dir: string;
}

/**
 * Read-only against the feed: GET manifest.json, then GET <uuid>.json for the newest `maxEvents`
 * (0 = manifest only, Infinity = all). Files already stored for the same manifest timestamp are
 * kept, so reruns are cheap. Nothing is matched against indicators in this slice.
 */
export async function ingest(
	source: MispSource,
	opts: { storeRoot?: string; maxEvents?: number; now?: Date; fetch?: Fetch } = {},
): Promise<IngestResult> {
	const f = opts.fetch ?? fetch;
	const max = opts.maxEvents ?? 25;
	const dir = path.join(opts.storeRoot ?? defaultStoreRoot(), source.name);
	const evDir = path.join(dir, "events");
	fs.mkdirSync(evDir, { recursive: true });
	const manifestText = await getText(
		f,
		`${source.baseUrl}/manifest.json`,
		source,
		MAX_MANIFEST,
		"misp manifest",
	);
	const manifest = parseManifest(JSON.parse(manifestText));
	fs.writeFileSync(path.join(dir, "manifest.json"), manifestText);
	const newest = [...manifest].sort(
		(a, b) => Number(b[1].timestamp ?? 0) - Number(a[1].timestamp ?? 0),
	);
	const want = Number.isFinite(max) ? newest.slice(0, max) : newest;
	const result: IngestResult = {
		source: source.name,
		manifestEvents: manifest.size,
		stored: 0,
		alreadyStored: 0,
		failed: [],
		dir,
	};
	const stamps = path.join(dir, "event-stamps.json");
	const seen: Record<string, string> = fs.existsSync(stamps)
		? JSON.parse(fs.readFileSync(stamps, "utf8"))
		: {};
	for (const [id, entry] of want) {
		const stamp = String(entry.timestamp ?? "");
		const file = path.join(evDir, `${id}.json`);
		if (fs.existsSync(file) && seen[id] === stamp) {
			result.alreadyStored++;
			continue;
		}
		try {
			const text = await getText(
				f,
				`${source.baseUrl}/${id}.json`,
				source,
				MAX_EVENT,
				`event ${id}`,
			);
			JSON.parse(text);
			fs.writeFileSync(file, text);
			seen[id] = stamp;
			result.stored++;
		} catch {
			result.failed.push(id);
		}
	}
	fs.writeFileSync(stamps, JSON.stringify(seen));
	fs.writeFileSync(
		path.join(dir, "ingest.json"),
		`${JSON.stringify({ ...result, fetchedAt: (opts.now ?? new Date()).toISOString() }, null, 2)}\n`,
	);
	return result;
}
