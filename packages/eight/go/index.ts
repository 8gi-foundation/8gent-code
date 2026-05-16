/**
 * Public surface for the eight/go module.
 *
 * Owned by 8DO. This barrel only re-exports verdict copy + lint. All
 * loop logic lives in @8gent/goal. Anything that wants to render a
 * /go user-facing string MUST go through here, not freelance.
 */

export {
	BannedTokenError,
	BANNED_TOKENS,
	VERDICT_ABANDONED,
	VERDICT_DONE,
	VERDICT_NEEDS_YOU,
	VERDICT_STILL_GOING,
	VERDICT_STOPPED,
	VERDICT_STUCK,
	assembleVerdict,
	assertNoBannedTokens,
	type VerdictFields,
	type VerdictKind,
} from "./verdicts";
