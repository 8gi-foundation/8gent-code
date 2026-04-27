import { subdomain } from "./handle.ts";
/**
 * Hetzner DNS adapter. Creates an A record for <handle>.8gentos.com pointing
 * at the Wave 4 prod box (HETZNER_BOX_IP). Idempotent: existing records with
 * the same value are detected and skipped; same-name-but-different-value records
 * are flagged as "rotate" but never auto-overwritten in B-2 (B-3 owns rotation).
 */
import type { Adapter, Ctx, PlanStep } from "./types.ts";

const HETZNER_API = "https://dns.hetzner.com/api/v1";
const ROOT_ZONE = "8gentos.com";

interface DnsRecord {
	id: string;
	name: string;
	type: string;
	value: string;
	zone_id: string;
}

async function findZoneId(ctx: Ctx, token: string): Promise<string> {
	const res = await ctx.fetch(`${HETZNER_API}/zones?name=${ROOT_ZONE}`, {
		headers: { "Auth-API-Token": token },
	});
	if (!res.ok) throw new Error(`Hetzner DNS zones lookup failed: ${res.status}`);
	const data = (await res.json()) as { zones?: Array<{ id: string; name: string }> };
	const zone = data.zones?.find((z) => z.name === ROOT_ZONE);
	if (!zone) throw new Error(`Hetzner DNS zone "${ROOT_ZONE}" not found`);
	return zone.id;
}

async function findRecord(
	ctx: Ctx,
	token: string,
	zoneId: string,
	name: string,
): Promise<DnsRecord | null> {
	const res = await ctx.fetch(`${HETZNER_API}/records?zone_id=${zoneId}`, {
		headers: { "Auth-API-Token": token },
	});
	if (!res.ok) throw new Error(`Hetzner DNS records lookup failed: ${res.status}`);
	const data = (await res.json()) as { records?: DnsRecord[] };
	return data.records?.find((r) => r.name === name && r.type === "A") ?? null;
}

async function createRecord(
	ctx: Ctx,
	token: string,
	zoneId: string,
	name: string,
	value: string,
): Promise<void> {
	const res = await ctx.fetch(`${HETZNER_API}/records`, {
		method: "POST",
		headers: { "Auth-API-Token": token, "Content-Type": "application/json" },
		body: JSON.stringify({ zone_id: zoneId, type: "A", name, value, ttl: 300 }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Hetzner DNS create failed: ${res.status} ${body}`);
	}
}

export const dnsAdapter: Adapter = {
	name: "hetzner-dns",
	async plan(handle, ctx): Promise<PlanStep> {
		const fqdn = subdomain(handle);
		const targetIp = ctx.env.HETZNER_BOX_IP;
		const token = ctx.env.HETZNER_DNS_API_TOKEN;
		if (!targetIp) {
			return ctx.apply
				? errStep(fqdn, "HETZNER_BOX_IP required for --apply")
				: {
						resource: `dns:${fqdn}`,
						status: "create",
						detail: `would create A ${fqdn} (HETZNER_BOX_IP unset, dry-run)`,
					};
		}
		if (!token) {
			return ctx.apply
				? errStep(fqdn, "HETZNER_DNS_API_TOKEN required for --apply")
				: {
						resource: `dns:${fqdn}`,
						status: "create",
						detail: `would create A ${fqdn} -> ${targetIp} (dry-run, no API call)`,
					};
		}

		try {
			const zoneId = await findZoneId(ctx, token);
			const recordName = handle;
			const existing = await findRecord(ctx, token, zoneId, recordName);

			if (existing) {
				if (existing.value === targetIp) {
					return {
						resource: `dns:${fqdn}`,
						status: "exists",
						detail: `A ${fqdn} -> ${targetIp} already present (id ${existing.id})`,
					};
				}
				return {
					resource: `dns:${fqdn}`,
					status: "rotate",
					detail: `A ${fqdn} points to ${existing.value}, expected ${targetIp}. Manual rotation required (B-2 will not auto-overwrite).`,
				};
			}

			if (!ctx.apply) {
				return {
					resource: `dns:${fqdn}`,
					status: "create",
					detail: `would create A ${fqdn} -> ${targetIp}`,
				};
			}

			await createRecord(ctx, token, zoneId, recordName, targetIp);
			return {
				resource: `dns:${fqdn}`,
				status: "create",
				detail: `created A ${fqdn} -> ${targetIp}`,
			};
		} catch (err) {
			return errStep(fqdn, (err as Error).message);
		}
	},
};

function errStep(fqdn: string, msg: string): PlanStep {
	return { resource: `dns:${fqdn}`, status: "error", detail: "DNS step failed", error: msg };
}
