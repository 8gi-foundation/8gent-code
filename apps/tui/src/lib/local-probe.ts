/**
 * Ask the local model servers which models they have, in this process.
 *
 * This used to run as a second runtime: `execFileSync(process.execPath, ["-e", PROBE, ...urls])`,
 * so it could stay synchronous at module load. In a compiled 8gent, process.execPath is 8gent
 * itself (#4671); on the Node build it is node with the TUI bundle's own command line, and a
 * blocked child froze input with the parent waiting on it (#4682). A fetch in this process
 * starts no child, so nothing on the input path waits on one.
 *
 * Every request is bounded by `timeoutMs` (body included), and they run at once, so a down
 * host costs one bound, not one per server. Never throws: an endpoint that does not answer
 * with JSON is `null` at its index.
 */

export type ProbeFetch = (
	url: string,
	init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export const LOCAL_PROBE_TIMEOUT_MS = 2000;

export async function probeLocalEndpoints(
	urls: readonly string[],
	opts: { fetch?: ProbeFetch; timeoutMs?: number } = {},
): Promise<unknown[]> {
	const doFetch: ProbeFetch = opts.fetch ?? ((u, init) => fetch(u, init));
	const timeoutMs = opts.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS;
	return Promise.all(
		urls.map(async (u) => {
			try {
				const r = await doFetch(u, { signal: AbortSignal.timeout(timeoutMs) });
				return r.ok ? await r.json() : null;
			} catch {
				return null;
			}
		}),
	);
}
