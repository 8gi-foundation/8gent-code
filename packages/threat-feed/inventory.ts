import type { Fetch } from "./feeds";
import { isLockfilePath, mergeDeps, parseLockfile } from "./lockfiles";
import type { RepoInventory } from "./types";

const MAX_BLOB_BYTES = 25 * 1024 * 1024;

export interface EcosystemManifest {
	org: string;
	repos: { name: string; status?: string }[];
}

/** Repos to scan: everything in the manifest except archive-proposed. Names are used as given, never as shell args. */
export function repoList(m: EcosystemManifest, includeArchived = false): string[] {
	return m.repos
		.filter((r) => includeArchived || r.status !== "archive-proposed")
		.map((r) => `${m.org}/${r.name}`);
}

function gh(f: Fetch, token: string) {
	return (url: string, accept = "application/vnd.github+json") =>
		f(url, {
			headers: { authorization: `Bearer ${token}`, accept, "x-github-api-version": "2022-11-28" },
		});
}

/** Read-only: one tree call plus one blob call per lockfile. No clone, no writes. */
export async function inventoryRepo(
	repo: string,
	token: string,
	f: Fetch = fetch,
): Promise<RepoInventory> {
	const get = gh(f, token);
	const inv: RepoInventory = { repo, deps: [], lockfiles: [], skipped: [] };
	const tr = await get(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`);
	if (!tr.ok) {
		inv.skipped.push(`repo not readable: HTTP ${tr.status}`);
		return inv;
	}
	const tree = (await tr.json()) as {
		truncated?: boolean;
		tree: { path: string; type: string; sha: string; size?: number }[];
	};
	if (tree.truncated) inv.skipped.push("tree truncated by GitHub, some lockfiles may be missing");
	const perFile: { path: string; raws: NonNullable<ReturnType<typeof parseLockfile>> }[] = [];
	for (const e of tree.tree) {
		if (e.type !== "blob" || !isLockfilePath(e.path)) continue;
		inv.lockfiles.push(e.path);
		if (e.path.endsWith("bun.lockb")) {
			inv.skipped.push(`${e.path}: binary bun lockfile, not parsed`);
			continue;
		}
		if ((e.size ?? 0) > MAX_BLOB_BYTES) {
			inv.skipped.push(`${e.path}: over ${MAX_BLOB_BYTES} bytes`);
			continue;
		}
		const br = await get(
			`https://api.github.com/repos/${repo}/git/blobs/${e.sha}`,
			"application/vnd.github.raw+json",
		);
		if (!br.ok) {
			inv.skipped.push(`${e.path}: HTTP ${br.status}`);
			continue;
		}
		try {
			const raws = parseLockfile(e.path, await br.text());
			if (raws) perFile.push({ path: e.path, raws });
		} catch (err) {
			inv.skipped.push(`${e.path}: parse failed (${(err as Error).message.slice(0, 80)})`);
		}
	}
	if (!inv.lockfiles.length && !tree.truncated) inv.skipped.push("no lockfile found");
	inv.deps = mergeDeps(perFile);
	return inv;
}
