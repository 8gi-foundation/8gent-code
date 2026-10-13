/**
 * The fixed set of communication styles, and the checks that keep any other
 * value out of user.json and out of the prompt (#3487). A leaf module: no
 * imports, so the prompt builder can use it without loading onboarding.
 */

export const COMMUNICATION_STYLES = [
	"sarcastic", // Dry-witted, seriously motivational, roasts you into greatness
	"concise", // Just the facts
	"detailed", // Teach me as we go
	"casual", // We're collaborators
	"formal", // Professional tone
	"action-first", // Next action first, numbered steps, one "Next:" line
] as const;

export type CommunicationStyle = (typeof COMMUNICATION_STYLES)[number];

/** True only for one of the fixed style keys, compared exactly. */
export function isCommunicationStyle(value: unknown): value is CommunicationStyle {
	return typeof value === "string" && (COMMUNICATION_STYLES as readonly string[]).includes(value);
}

/**
 * A language code as user.json stores it: "en", "pt-BR", "zh-Hant". Two or
 * three ASCII letters, then up to three subtags of 2 to 8 letters or digits.
 */
const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export function isLanguageCode(value: unknown): value is string {
	return typeof value === "string" && LANGUAGE_CODE.test(value);
}
