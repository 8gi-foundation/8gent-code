/**
 * LinkedIn Unofficial API Client
 *
 * Uses the li_at session cookie to call LinkedIn's internal voyager API.
 * All endpoints are reverse-engineered from the mobile app.
 * This is the same approach used by Phantombuster, Expandi, and Lemlist.
 *
 * Do NOT log the li_at cookie value anywhere.
 */

import type { Lead, Signal } from "./types";
import { randomId } from "./utils";

const BASE_URL = "https://www.linkedin.com/voyager/api";

interface LinkedInHeaders {
	cookie: string;
	"csrf-token": string;
	"x-restli-protocol-version": string;
	"x-li-lang": string;
	accept: string;
	"user-agent": string;
}

function buildHeaders(liAt: string, jsessionId: string): LinkedInHeaders {
	return {
		cookie: `li_at=${liAt}; JSESSIONID="${jsessionId}"`,
		"csrf-token": jsessionId,
		"x-restli-protocol-version": "2.0.0",
		"x-li-lang": "en_US",
		accept: "application/vnd.linkedin.normalized+json+2.1",
		"user-agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	};
}

// Extract JSESSIONID from cookie string or env
function getJsessionId(liAt: string): string {
	const env = process.env.LINKEDIN_JSESSIONID;
	if (env) return env;
	// Fall back: derive from li_at (not ideal but works for basic use)
	return liAt.slice(0, 32);
}

async function liGet(
	path: string,
	params: Record<string, string> = {},
): Promise<any> {
	const liAt = process.env.LINKEDIN_SESSION_COOKIE;
	if (!liAt) throw new Error("LINKEDIN_SESSION_COOKIE not set");
	const jsessionId = getJsessionId(liAt);
	const url = new URL(`${BASE_URL}${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	const res = await fetch(url.toString(), {
		headers: buildHeaders(liAt, jsessionId) as any,
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error(
			`LinkedIn auth failed (${res.status}) - refresh li_at cookie`,
		);
	}
	if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${path}`);
	return res.json();
}

async function liPost(path: string, body: unknown): Promise<any> {
	const liAt = process.env.LINKEDIN_SESSION_COOKIE;
	if (!liAt) throw new Error("LINKEDIN_SESSION_COOKIE not set");
	const jsessionId = getJsessionId(liAt);

	const res = await fetch(`${BASE_URL}${path}`, {
		method: "POST",
		headers: {
			...(buildHeaders(liAt, jsessionId) as any),
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error(
			`LinkedIn auth failed (${res.status}) - refresh li_at cookie`,
		);
	}
	if (!res.ok) throw new Error(`LinkedIn API POST ${res.status}: ${path}`);
	return res.json();
}

// ── Search ────────────────────────────────────────────────────────────

export interface SearchCriteria {
	keywords?: string;
	titles?: string[];
	companies?: string[];
	locations?: string[];
	limit?: number;
}

export async function searchPeople(criteria: SearchCriteria): Promise<Lead[]> {
	const keywords = [
		criteria.keywords,
		...(criteria.titles || []).map((t) => `"${t}"`),
	]
		.filter(Boolean)
		.join(" ");

	const data = await liGet("/search/blended", {
		keywords,
		origin: "SWITCH_SEARCH_VERTICAL",
		q: "people",
		count: String(Math.min(criteria.limit ?? 25, 49)),
		start: "0",
	});

	const elements = data?.data?.elements?.[0]?.elements || [];
	const leads: Lead[] = [];

	for (const el of elements) {
		try {
			const profile = el?.targetUnion?.memberToMemberConnectionHit || el;
			const id = profile?.publicIdentifier || profile?.member?.publicIdentifier;
			if (!id) continue;

			leads.push({
				id: randomId(),
				profileUrl: `https://www.linkedin.com/in/${id}`,
				publicId: id,
				name: `${profile?.firstName || ""} ${profile?.lastName || ""}`.trim(),
				title: profile?.headline || "",
				company: profile?.currentCompany?.name || "",
				location: profile?.location?.name || "",
				signals: [],
				connectionDegree: profile?.distance?.value ?? 3,
				enrichedAt: new Date().toISOString(),
			});
		} catch {
			// malformed element, skip
		}
	}

	return leads;
}

// ── Profile ───────────────────────────────────────────────────────────

export async function getProfile(publicId: string): Promise<Partial<Lead>> {
	const data = await liGet(`/identity/profiles/${publicId}`, {
		decorationId:
			"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-86",
	});

	const profile = data?.data || data;
	return {
		publicId,
		profileUrl: `https://www.linkedin.com/in/${publicId}`,
		name: `${profile?.firstName || ""} ${profile?.lastName || ""}`.trim(),
		title: profile?.headline || "",
		company: profile?.experience?.[0]?.company?.name || "",
		location: profile?.locationName || "",
		enrichedAt: new Date().toISOString(),
	};
}

export async function getRecentActivity(publicId: string): Promise<string[]> {
	// Returns recent post summaries to use as signal hooks
	const data = await liGet(`/identity/profiles/${publicId}/posts`, {
		count: "5",
	});

	const posts = data?.data?.elements || [];
	return posts
		.slice(0, 3)
		.map((p: any) => p?.commentary?.text?.slice(0, 150))
		.filter(Boolean);
}

// ── Messaging ─────────────────────────────────────────────────────────

export async function sendConnectionRequest(
	profileUrn: string,
	note: string,
): Promise<{ success: boolean; error?: string }> {
	if (note.length > 300) {
		return { success: false, error: "Connection note exceeds 300 chars" };
	}

	try {
		await liPost("/growth/normInvitations", {
			invitee: {
				inviteeUnion: { memberProfile: profileUrn },
			},
			message: note,
			trackingId: randomId(),
		});
		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message };
	}
}

export async function sendMessage(
	conversationUrn: string,
	body: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		await liPost("/messaging/conversations", {
			keyVersion: "LEGACY_INBOX",
			conversationUrn,
			message: {
				body: { text: body },
				renderContentUnions: [],
			},
		});
		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message };
	}
}

// ── Replies ───────────────────────────────────────────────────────────

export interface ReplyEntry {
	conversationUrn: string;
	senderName: string;
	lastMessage: string;
	timestamp: string;
	isUnread: boolean;
}

export async function getRecentReplies(since?: string): Promise<ReplyEntry[]> {
	const data = await liGet("/messaging/conversations", {
		keyVersion: "LEGACY_INBOX",
		q: "participantReceipts",
		count: "20",
	});

	const conversations = data?.data?.elements || [];
	const cutoff = since ? new Date(since).getTime() : 0;

	return conversations
		.filter((c: any) => {
			const ts = c?.lastActivityAt;
			return ts > cutoff;
		})
		.map((c: any) => ({
			conversationUrn: c?.entityUrn,
			senderName:
				c?.participants?.[0]?.firstName + " " + c?.participants?.[0]?.lastName,
			lastMessage: c?.events?.[0]?.eventContent?.message?.body?.text || "",
			timestamp: new Date(c?.lastActivityAt).toISOString(),
			isUnread: c?.read === false,
		}));
}
