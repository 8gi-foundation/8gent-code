/**
 * MCP Server - Tool definitions and handlers.
 *
 * Implements the MCP protocol over HTTP (streamable SSE).
 * These tools are what claude.ai (or 8gent-code clients) call.
 */

import { getCampaignStats, getLead, getTemplates, upsertLead } from "./campaign-db";
import { getInsights, reflect } from "./hyperagent";
import {
	getProfile,
	getRecentReplies,
	searchPeople,
	sendConnectionRequest,
	sendMessage,
} from "./linkedin-api";
import { isKilled } from "./policy";
import { ReviewQueue } from "./queue";
import { RateLimiter } from "./rate-limiter";
import { buildSignalHook, enrichLead } from "./signal-engine";
import { notifyApprovalNeeded } from "./telegram-notify";
import type { MCPToolCall, MCPToolResult } from "./types";
import { randomId } from "./utils";

const ACCOUNT_ID = process.env.VESSEL_ACCOUNT_ID || "default";
const limiter = new RateLimiter(ACCOUNT_ID);

const MAX_MESSAGE_CHARS = 2000;
const URN_RE = /^urn:li:[A-Za-z_]+:\S{1,200}$/;

// Writes never run from a tool call. They are queued and run on approval.
let queue: ReviewQueue | null = null;

export function getQueue(): ReviewQueue {
	if (!queue) {
		queue = new ReviewQueue(
			ACCOUNT_ID,
			{
				connection_requests: (p) => sendConnectionRequest(p.profileUrn, p.note),
				messages: (p) => sendMessage(p.conversationUrn, p.body),
			},
			notifyApprovalNeeded,
		);
	}
	return queue;
}

/** Test seam: swap in a queue with fake executors and notifier. */
export function setQueue(q: ReviewQueue): void {
	queue = q;
}

async function queued(
	outcome: Awaited<ReturnType<ReviewQueue["enqueue"]>>,
): Promise<MCPToolResult> {
	return outcome.ok ? text(outcome.message) : error(outcome.message);
}

// ── Tool definitions (returned on initialize) ─────────────────────────

export const TOOL_DEFINITIONS = [
	{
		name: "linkedin_search_leads",
		description:
			"Search LinkedIn for people matching criteria. Returns enriched lead list with buying signals.",
		inputSchema: {
			type: "object",
			properties: {
				keywords: {
					type: "string",
					description: "Search keywords, job titles, or company names",
				},
				titles: {
					type: "array",
					items: { type: "string" },
					description: "Job title filters",
				},
				locations: {
					type: "array",
					items: { type: "string" },
					description: "Location filters",
				},
				limit: {
					type: "number",
					description: "Max results (default 25, max 49)",
				},
			},
		},
	},
	{
		name: "linkedin_get_profile",
		description: "Get full profile data and recent activity for a LinkedIn public ID or URL.",
		inputSchema: {
			type: "object",
			required: ["publicId"],
			properties: {
				publicId: {
					type: "string",
					description: "LinkedIn public identifier (from URL: linkedin.com/in/[this-part])",
				},
			},
		},
	},
	{
		name: "linkedin_send_connection",
		description:
			"Queue a connection request with a personalized note (max 300 chars). It is sent only after James approves it.",
		inputSchema: {
			type: "object",
			required: ["profileUrn", "note"],
			properties: {
				profileUrn: { type: "string", description: "LinkedIn profile URN" },
				note: {
					type: "string",
					description: "Personalized connection note (max 300 chars)",
				},
			},
		},
	},
	{
		name: "linkedin_send_message",
		description:
			"Queue a direct message to an existing connection. It is sent only after James approves it.",
		inputSchema: {
			type: "object",
			required: ["conversationUrn", "body"],
			properties: {
				conversationUrn: {
					type: "string",
					description: "LinkedIn conversation URN",
				},
				body: { type: "string", description: "Message text" },
			},
		},
	},
	{
		name: "linkedin_get_replies",
		description: "Get recent replies across all active campaigns. Returns unread conversations.",
		inputSchema: {
			type: "object",
			properties: {
				since: {
					type: "string",
					description: "ISO timestamp - only return replies after this date",
				},
			},
		},
	},
	{
		name: "linkedin_get_stats",
		description: "Get campaign performance stats: send counts, reply rates, template performance.",
		inputSchema: {
			type: "object",
			properties: {
				campaignId: {
					type: "string",
					description: "Filter to specific campaign (omit for all)",
				},
			},
		},
	},
	{
		name: "linkedin_get_insights",
		description: "Get HyperAgent insights: which templates are winning, which are being evolved.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "linkedin_trigger_reflection",
		description:
			"Manually trigger HyperAgent reflection loop to evolve underperforming templates now.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "linkedin_get_rate_status",
		description: "Check daily send budget remaining across all action types.",
		inputSchema: { type: "object", properties: {} },
	},
];

// ── Tool dispatcher ───────────────────────────────────────────────────

export async function dispatchTool(call: MCPToolCall): Promise<MCPToolResult> {
	if (isKilled()) return error("LinkedIn vessel is paused (kill switch on). No actions run.");
	const args = call.arguments ?? {};

	try {
		switch (call.name) {
			case "linkedin_search_leads": {
				const leads = await searchPeople({
					keywords: args.keywords as string,
					titles: args.titles as string[],
					locations: args.locations as string[],
					limit: (args.limit as number) || 25,
				});

				// Enrich top 10 with signals (rate-limited, don't hammer all)
				const enriched = await Promise.all(leads.slice(0, 10).map((l) => enrichLead(l)));
				const rest = leads.slice(10);
				const allLeads = [...enriched, ...rest];

				// Save to DB
				allLeads.forEach((l) => upsertLead(l));

				const summary = allLeads.map((l) => ({
					name: l.name,
					title: l.title,
					company: l.company,
					profileUrl: l.profileUrl,
					topSignal: l.signals[0]?.summary || "No signal detected",
					signalHook: buildSignalHook(l),
					connectionDegree: l.connectionDegree,
				}));

				return text(JSON.stringify(summary, null, 2));
			}

			case "linkedin_get_profile": {
				const publicId = (args.publicId as string)
					.replace("https://www.linkedin.com/in/", "")
					.replace(/\/$/, "");
				const profile = await getProfile(publicId);
				const lead = {
					id: randomId(),
					signals: [],
					connectionDegree: 3 as const,
					...profile,
				} as any;
				const enriched = await enrichLead(lead);
				upsertLead(enriched);

				return text(
					JSON.stringify(
						{
							...enriched,
							signalHook: buildSignalHook(enriched),
							suggestedOpener:
								buildSignalHook(enriched) || "No strong signal found - consider skipping",
						},
						null,
						2,
					),
				);
			}

			case "linkedin_send_connection": {
				const { profileUrn, note } = args as { profileUrn?: unknown; note?: unknown };
				if (typeof profileUrn !== "string" || !URN_RE.test(profileUrn)) {
					return error("profileUrn must be a LinkedIn URN (urn:li:...)");
				}
				if (typeof note !== "string" || note.trim() === "") return error("note is required");
				if (note.length > 300) return error("Note exceeds 300 chars");
				return queued(
					await getQueue().enqueue("connection_requests", profileUrn, { profileUrn, note }, note),
				);
			}

			case "linkedin_send_message": {
				const { conversationUrn, body } = args as { conversationUrn?: unknown; body?: unknown };
				if (typeof conversationUrn !== "string" || !URN_RE.test(conversationUrn)) {
					return error("conversationUrn must be a LinkedIn URN (urn:li:...)");
				}
				if (typeof body !== "string" || body.trim() === "") return error("body is required");
				if (body.length > MAX_MESSAGE_CHARS)
					return error(`Message exceeds ${MAX_MESSAGE_CHARS} chars`);
				return queued(
					await getQueue().enqueue("messages", conversationUrn, { conversationUrn, body }, body),
				);
			}

			case "linkedin_get_replies": {
				const replies = await getRecentReplies(args.since as string | undefined);
				return text(JSON.stringify(replies, null, 2));
			}

			case "linkedin_get_stats": {
				const stats = getCampaignStats(args.campaignId as string | undefined);
				return text(JSON.stringify(stats, null, 2));
			}

			case "linkedin_get_insights": {
				return text(getInsights());
			}

			case "linkedin_trigger_reflection": {
				const result = await reflect();
				return text(
					[
						"Reflection complete.",
						`Evolved: ${result.evolved} templates`,
						`Skipped: ${result.skipped}`,
						result.details.length > 0 ? `\nDetails:\n${result.details.join("\n")}` : "",
					].join("\n"),
				);
			}

			case "linkedin_get_rate_status": {
				const status = limiter.getStatus();
				const lines = Object.entries(status).map(
					([action, s]: [string, any]) =>
						`${action}: ${s.used}/${s.cap} used (${s.remaining} remaining)`,
				);
				return text(lines.join("\n"));
			}

			default:
				return error(`Unknown tool: ${call.name}`);
		}
	} catch (e: any) {
		return error(`Tool error: ${e.message}`);
	}
}

// ── MCP message handler (called by HTTP layer) ────────────────────────

export function handleMCPRequest(body: any): any {
	const { method, id, params } = body;

	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "linkedin-vessel", version: "1.0.0" },
			},
		};
	}

	if (method === "tools/list") {
		return {
			jsonrpc: "2.0",
			id,
			result: { tools: TOOL_DEFINITIONS },
		};
	}

	// Async tools/call handled separately (returns promise)
	return null;
}

// ── Helpers ───────────────────────────────────────────────────────────

function text(s: string): MCPToolResult {
	return { content: [{ type: "text", text: s }] };
}

function error(s: string): MCPToolResult {
	return { content: [{ type: "text", text: s }], isError: true };
}
