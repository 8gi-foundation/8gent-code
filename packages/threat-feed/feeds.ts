import { depKey } from "./match";
import type { Dep, KevEntry, OsvVuln } from "./types";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
export const OSV_VULN = "https://api.osv.dev/v1/vulns/";
export const KEV_URL =
	"https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const BATCH_SIZE = 1000;

async function ok(res: Response, what: string): Promise<Response> {
	if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
	return res;
}

/** Query every unique dep against OSV. Follows next_page_token. Returns ids per dep key. */
export async function queryOsv(deps: Dep[], f: Fetch = fetch): Promise<Map<string, string[]>> {
	const uniq = [...new Map(deps.map((d) => [depKey(d), d])).values()];
	const out = new Map<string, string[]>();
	for (let i = 0; i < uniq.length; i += BATCH_SIZE) {
		let pending = uniq.slice(i, i + BATCH_SIZE).map((d) => ({
			d,
			body: { package: { name: d.name, ecosystem: d.ecosystem }, version: d.version } as Record<
				string,
				unknown
			>,
		}));
		while (pending.length) {
			const res = await ok(
				await f(OSV_BATCH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ queries: pending.map((p) => p.body) }),
				}),
				"osv querybatch",
			);
			const { results } = (await res.json()) as {
				results: { vulns?: { id: string }[]; next_page_token?: string }[];
			};
			if (!Array.isArray(results) || results.length !== pending.length)
				throw new Error("osv querybatch: result count mismatch");
			const next: typeof pending = [];
			results.forEach((r, idx) => {
				const p = pending[idx];
				const k = depKey(p.d);
				const ids = out.get(k) ?? [];
				for (const v of r.vulns ?? []) if (!ids.includes(v.id)) ids.push(v.id);
				out.set(k, ids);
				if (r.next_page_token)
					next.push({ d: p.d, body: { ...p.body, page_token: r.next_page_token } });
			});
			pending = next;
		}
	}
	return out;
}

/** Fetch full records for ids, a few at a time. Failures are collected, not thrown. */
export async function fetchVulns(
	ids: string[],
	f: Fetch = fetch,
	concurrency = 8,
): Promise<{ vulns: Map<string, OsvVuln>; failed: string[] }> {
	const vulns = new Map<string, OsvVuln>();
	const failed: string[] = [];
	const queue = [...new Set(ids)];
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
			for (let id = queue.pop(); id; id = queue.pop()) {
				try {
					const res = await ok(await f(OSV_VULN + encodeURIComponent(id)), `osv ${id}`);
					vulns.set(id, (await res.json()) as OsvVuln);
				} catch {
					failed.push(id);
				}
			}
		}),
	);
	return { vulns, failed };
}

export async function fetchKev(f: Fetch = fetch): Promise<Map<string, KevEntry>> {
	const res = await ok(await f(KEV_URL), "cisa kev");
	return parseKev(await res.json());
}

export function parseKev(doc: unknown): Map<string, KevEntry> {
	const list = (doc as { vulnerabilities?: KevEntry[] })?.vulnerabilities;
	if (!Array.isArray(list)) throw new Error("cisa kev: no vulnerabilities array");
	return new Map(list.filter((e) => e?.cveID).map((e) => [e.cveID, e]));
}
