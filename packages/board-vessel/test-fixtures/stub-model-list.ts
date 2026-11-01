/**
 * Test preload for vessel.boot.test.ts: replaces fetch so the real vessel entry
 * point boots without touching the network. STUB_MODELS is a comma list served
 * as the provider's /models; STUB_MODELS_STATUS overrides the HTTP status.
 */
const ids = (process.env.STUB_MODELS || "").split(",").filter(Boolean);
const listStatus = Number(process.env.STUB_MODELS_STATUS || "200");
globalThis.fetch = (async (url: string) => {
	if (String(url).endsWith("/models")) {
		return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
			status: listStatus,
		});
	}
	throw new Error(`stub: unexpected request to ${url}`);
}) as unknown as typeof fetch;

export {};
