/**
 * LinkedIn Vessel - Shared Types
 */

export interface Lead {
	id: string;
	profileUrl: string;
	publicId: string; // linkedin public identifier
	name: string;
	title: string;
	company: string;
	location: string;
	signals: Signal[];
	connectionDegree: 1 | 2 | 3;
	enrichedAt: string;
}

export interface Signal {
	type: "job_posting" | "funding" | "post_engagement" | "job_change" | "company_news";
	summary: string;
	strength: number; // 0-1
	source: string;
	detectedAt: string;
}

export interface Campaign {
	id: string;
	name: string;
	icp: string;
	status: "active" | "paused" | "completed";
	touchSequence: Touch[];
	leadsTotal: number;
	leadsContacted: number;
	replies: number;
	qualified: number;
	createdAt: string;
}

export interface Touch {
	step: number;
	type: "connection_request" | "message";
	templateId: string;
	delayDays: number;
}

export interface MessageTemplate {
	id: string;
	name: string;
	type: "connection_request" | "message";
	body: string;
	signalHook: string; // what signal this template leads with
	sendCount: number;
	replyCount: number;
	replyRate: number; // replyCount / sendCount
	version: number;
	evolvedFromId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MessageRecord {
	id: string;
	campaignId: string;
	leadId: string;
	templateId: string;
	touchStep: number;
	body: string;
	sentAt: string;
	replied: boolean;
	repliedAt: string | null;
	qualified: boolean;
}

export interface AccountHealth {
	sessionCookie: string; // masked
	dailySends: number;
	dailyCap: number;
	connectionRequests: number;
	connectionRequestCap: number;
	warningFlag: boolean;
	lastChecked: string;
}

// MCP Tool call/response shapes
export interface MCPToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface MCPToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

// Control plane registration
export interface VesselManifest {
	vesselId: string;
	vesselType: "linkedin";
	tools: string[];
	endpoint: string;
	healthUrl: string;
	registeredAt: string;
}
