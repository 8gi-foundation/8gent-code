/**
 * Officer routing - maps Telegram message text to the right vessel.
 *
 * Matches against keyword lists from board-vessels.yaml (baked in here).
 * Falls back to 8EO if no match.
 */

export type OfficerCode =
	| "8EO"
	| "8TO"
	| "8PO"
	| "8DO"
	| "8SO"
	| "8MO"
	| "8CO"
	| "8GO";

interface OfficerRoute {
	code: OfficerCode;
	fly_app: string;
	name: string;
	keywords: string[];
}

const ROUTES: OfficerRoute[] = [
	{
		code: "8TO",
		fly_app: "8gi-rishi-vessel",
		name: "Rishi",
		keywords: [
			"architecture",
			"pr",
			"ci",
			"deploy",
			"infra",
			"test",
			"bug",
			"code",
			"rishi",
		],
	},
	{
		code: "8PO",
		fly_app: "8gi-samantha-vessel",
		name: "Samantha",
		keywords: [
			"feature",
			"roadmap",
			"user",
			"scope",
			"product",
			"onboarding",
			"samantha",
		],
	},
	{
		code: "8DO",
		fly_app: "8gi-moira-vessel",
		name: "Moira",
		keywords: [
			"design",
			"brand",
			"ui",
			"visual",
			"color",
			"font",
			"logo",
			"moira",
		],
	},
	{
		code: "8SO",
		fly_app: "8gi-karen-vessel",
		name: "Karen",
		keywords: [
			"security",
			"audit",
			"dependency",
			"vulnerability",
			"policy",
			"secret",
			"karen",
		],
	},
	{
		code: "8MO",
		fly_app: "8gi-zara-vessel",
		name: "Zara",
		keywords: [
			"content",
			"post",
			"launch",
			"social",
			"marketing",
			"growth",
			"linkedin",
			"zara",
		],
	},
	{
		code: "8CO",
		fly_app: "8gi-luis-vessel",
		name: "Luis",
		keywords: ["community", "discord", "contributor", "culture", "luis"],
	},
	{
		code: "8GO",
		fly_app: "8gi-solomon-vessel",
		name: "Solomon",
		keywords: [
			"governance",
			"compliance",
			"constitution",
			"gdpr",
			"coppa",
			"ethics",
			"solomon",
		],
	},
	{
		code: "8EO",
		fly_app: "8gi-daniel-vessel",
		name: "AI James",
		keywords: [
			"strategy",
			"decision",
			"priority",
			"board",
			"plan",
			"delegate",
			"daniel",
		],
	},
];

export interface RouteResult {
	code: OfficerCode;
	fly_app: string;
	name: string;
	matched_keyword?: string;
}

export function routeMessage(text: string): RouteResult {
	const lower = text.toLowerCase();

	// Check explicit @mention format first: "@rishi ..." or "rishi:"
	for (const route of ROUTES) {
		const mention = `@${route.name.toLowerCase()}`;
		if (
			lower.startsWith(mention) ||
			lower.startsWith(`${route.name.toLowerCase()}:`)
		) {
			return { ...route, matched_keyword: route.name.toLowerCase() };
		}
	}

	// Keyword scan - score by number of matching keywords
	let best: { route: OfficerRoute; score: number } | null = null;
	for (const route of ROUTES) {
		const score = route.keywords.filter((kw) => lower.includes(kw)).length;
		if (score > 0 && (!best || score > best.score)) {
			best = { route, score };
		}
	}

	if (best) {
		const kw = best.route.keywords.find((kw) => lower.includes(kw));
		return { ...best.route, matched_keyword: kw };
	}

	// Default to 8EO
	const eeo = ROUTES.find((r) => r.code === "8EO")!;
	return { ...eeo };
}
