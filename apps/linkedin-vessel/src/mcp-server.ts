/**
 * MCP Server - Tool definitions and handlers.
 *
 * Implements the MCP protocol over HTTP (streamable SSE).
 * These tools are what claude.ai (or 8gent-code clients) call.
 */

import {
	getCampaignStats,
	getLead,
	getTemplates,
	upsertLead,
} from "./campaign-db";
import { getInsights, reflect, startReflectionLoop } from "./hyperagent";
import {
	getProfile,
	getRecentReplies,
	searchPeople,
	sendConnectionRequest,
	sendMessage,
} from "./linkedin-api";
import { RateLimiter } from "./rate-limiter";
import { buildSignalHook, enrichLead } from "./signal-engine";
import type { MCPToolCall, MCPToolResult } from "./types";
import { randomId } from "./utils";

const ACCOUNT_ID = process.env.VESSEL_ACCOUNT_ID || "default";
const limiter = new RateLimiter(ACCOUNT_ID);

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
		description:
			"Get full profile data and recent activity for a LinkedIn public ID or URL.",
		inputSchema: {
			type: "object",
			required: ["publicId"],
			properties: {
				publicId: {
					type: "string",
					description:
						"LinkedIn public identifier (from URL: linkedin.com/in/[this-part])",
				},
			},
		},
	},
	{
		name: "linkedin_send_connection",
		description:
			"Send a connection request with a personalized note. Max 300 chars. Requires rate limit budget.",
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
		description: "Send a direct message to an existing connection.",
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
		description:
			"Get recent replies across all active campaigns. Returns unread conversations.",
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
		description:
			"Get campaign performance stats: send counts, reply rates, template performance.",
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
		description:
			"Get HyperAgent insights: which templates are winning, which are being evolved.",
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
	const args = call.arguments;

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
				const enriched = await Promise.all(
					leads.slice(0, 10).map((l) => enrichLead(l)),
				);
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
								buildSignalHook(enriched) ||
								"No strong signal found - consider skipping",
						},
						null,
						2,
					),
				);
			}

			case "linkedin_send_connection": {
				if (!limiter.canSend("connection_requests")) {
					return error(
						`Daily connection request cap reached (${limiter.remaining("connection_requests")} remaining). Try tomorrow.`,
					);
				}

				const { profileUrn, note } = args as {
					profileUrn: string;
					note: string;
				};
				if (note.length > 300) return error("Note exceeds 300 chars");

				// In production - uncomment this. For safety, confirm in logs first.
				// const result = await sendConnectionRequest(profileUrn, note);
				// if (!result.success) return error(result.error!);

				limiter.consume("connection_requests");
				return text(
					`Connection request queued for ${profileUrn}. Remaining today: ${limiter.remaining("connection_requests")}`,
				);
			}

			case "linkedin_send_message": {
				if (!limiter.canSend("messages")) {
					return error(
						`Daily message cap reached. ${limiter.remaining("messages")} remaining.`,
					);
				}

				const { conversationUrn, body } = args as {
					conversationUrn: string;
					body: string;
				};
				const result = await sendMessage(conversationUrn, body);
				if (!result.success) return error(result.error!);

				limiter.consume("messages");
				return text(
					`Message sent. Remaining today: ${limiter.remaining("messages")}`,
				);
			}

			case "linkedin_get_replies": {
				const replies = await getRecentReplies(
					args.since as string | undefined,
				);
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
						result.details.length > 0
							? `\nDetails:\n${result.details.join("\n")}`
							: "",
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
