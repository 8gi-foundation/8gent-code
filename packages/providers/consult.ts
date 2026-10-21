/**
 * /consult (#4608): ask a cloud model one question without handing over the
 * details. One stateless request: no conversation history, only the text the
 * person typed, passed through the masker (./mask.ts). The reply is advice
 * text; its placeholders are filled back in here, on this machine.
 *
 * Routing is not decided here. local-only refuses with the same plain message
 * as every other cloud call (decideRoute). The ledger line is written by the
 * wire (locality-wire.ts) when the request leaves, and carries masked:true
 * because the call runs inside maskedScope. Neither the question, the reply
 * nor the placeholder map is ever handed to the ledger.
 */
import { readFileSync } from "node:fs";
import {
	type ProviderManager,
	type ProviderName,
	getProviderManager,
	isCloudProvider,
} from "./index";
import {
	type PolicyState,
	decideRoute,
	maskedScope,
	readPolicyState,
	settingsPath,
} from "./locality";
import { createMasker, describeCounts } from "./mask";

export interface ConsultSettings {
	/** routing.mask: default true. */
	mask: boolean;
	/** routing.maskTerms: names, client names, project names to hide. */
	terms: string[];
	/** routing.consultProvider: which provider /consult uses; empty means the active one if it is cloud. */
	provider?: string;
}

/**
 * Read routing.mask, routing.maskTerms and routing.consultProvider. Fails toward
 * more masking: a file that cannot be read or parsed gives mask on, no extra terms.
 */
export function readConsultSettings(file?: string): ConsultSettings {
	const safe: ConsultSettings = { mask: true, terms: [] };
	// Under `bun test` the real settings file is never read unless a test names one.
	if (!file && process.env.NODE_ENV === "test") return safe;
	let v: any;
	try {
		let raw = readFileSync(file ?? settingsPath(), "utf8");
		if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
		v = JSON.parse(raw);
	} catch {
		return safe;
	}
	const r = v && typeof v === "object" ? v.routing : undefined;
	if (!r || typeof r !== "object" || Array.isArray(r)) return safe;
	return {
		mask: r.mask !== false,
		terms: Array.isArray(r.maskTerms)
			? r.maskTerms.filter((t: unknown): t is string => typeof t === "string")
			: [],
		provider:
			typeof r.consultProvider === "string" ? r.consultProvider.trim() || undefined : undefined,
	};
}

export interface ConsultReply {
	text: string;
	provider: string;
	model: string;
}

export interface ConsultDeps {
	state: () => PolicyState;
	settings: () => ConsultSettings;
	/** One stateless request to the person's configured cloud provider. */
	send: (
		messages: { role: "system" | "user"; content: string }[],
		provider?: string,
	) => Promise<ConsultReply>;
}

const SYSTEM =
	"You are an outside consultant. Reply with advice as plain text only; you cannot run tools or see any files. Tokens written like {{EMAIL_1}} or {{TERM_2}} stand for private values that were hidden from you: keep them exactly as written and never guess what they are.";

export const CONSULT_USAGE =
	"Usage: /consult <question>. One stateless question to your cloud model, with secrets and personal data masked first.";

/** The /consult command. Returns the text to show; never throws. */
export async function consult(question: string, deps: ConsultDeps): Promise<string> {
	const q = question.trim();
	if (!q) return CONSULT_USAGE;

	const st = deps.state();
	const route = decideRoute({
		policy: st.policy,
		provider: "a cloud provider",
		local: false,
		pickedForTab: true,
		why: st.why,
	});
	if (route.action === "refuse") return route.message;

	const settings = deps.settings();
	const masker = createMasker({ terms: settings.terms });
	const masked = settings.mask ? masker.mask(q) : q;
	if (settings.mask && masker.leaks(masked)) {
		return "Nothing was sent: the masked text still looks like it holds a secret or personal detail. Rewrite the question without it.";
	}

	let reply: ConsultReply;
	try {
		reply = await maskedScope.run({ masked: settings.mask }, () =>
			deps.send(
				[
					{ role: "system", content: SYSTEM },
					{ role: "user", content: masked },
				],
				settings.provider,
			),
		);
	} catch (e) {
		return `Consult failed, nothing was applied: ${e instanceof Error ? e.message : String(e)}`;
	}

	const lines: string[] = [];
	if (settings.mask) {
		const hid = describeCounts(masker.counts());
		lines.push(
			hid
				? `Masked before sending: ${hid}. This is what left your machine:`
				: "Masked before sending: nothing matched. This is what left your machine:",
			masked,
		);
	} else {
		lines.push("Masking is off (routing.mask is false). Your question was sent as typed.");
	}
	lines.push(
		`Advice from ${reply.provider} (${reply.model}), placeholders filled in locally:`,
		settings.mask ? masker.unmask(reply.text) : reply.text,
	);
	return lines.join("\n");
}

// ---------- the real sender ----------

/**
 * Which provider /consult uses: routing.consultProvider, else the active provider
 * if it is cloud, else the first enabled cloud provider that has a key. Never a
 * name written here: it is the person's configured choice.
 */
export function pickConsultProvider(mgr: ProviderManager, want?: string): ProviderName {
	if (want) {
		if (!mgr.isKnownProvider(want))
			throw new Error(`routing.consultProvider "${want}" is not a known provider.`);
		return want;
	}
	const active = mgr.getActiveProvider();
	if (isCloudProvider(active)) return active.name;
	const other = mgr.listEnabledProviders().find((p) => isCloudProvider(p) && mgr.getApiKey(p.name));
	if (!other) {
		throw new Error(
			"No cloud provider is configured. Add a key with /provider, or set routing.consultProvider.",
		);
	}
	return other.name;
}

/** Sender over a ProviderManager. The manager's own PII gate still runs on top of the masker. */
export function providerSend(mgr: ProviderManager): ConsultDeps["send"] {
	return async (messages, want) => {
		const providerName = pickConsultProvider(mgr, want);
		const res = await mgr.chat({ messages, providerName, maxTokens: 2048 });
		return { text: res.content, provider: String(res.provider), model: res.model };
	};
}

export function defaultConsultDeps(): ConsultDeps {
	return {
		state: () => readPolicyState(),
		settings: () => readConsultSettings(),
		send: (m, p) => providerSend(getProviderManager())(m, p),
	};
}
