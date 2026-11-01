/**
 * 8gent Code - secret guard for names
 *
 * A name is something a person reads on a tab or in a greeting. An API key
 * pasted into a name box becomes a tab title and is saved in plain text, so
 * every place that takes a typed name asks looksLikeSecret() first (#5098).
 * Keys belong in /apikeys, on a masked screen.
 *
 * The value is never echoed: the notices below do not take it as input.
 */

/** Provider key prefixes and token shapes that are never a name. */
const KEY_SHAPES: RegExp[] = [
	/^sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}/, // sk-, sk-ant-, sk-or-, sk-proj- (a digit, or 40+ chars below)
	/^sk-[A-Za-z0-9_-]{37,}/,
	/^gh[pousr]_[A-Za-z0-9]{16,}/, // ghp_, gho_, ghu_, ghs_, ghr_
	/^github_pat_[A-Za-z0-9_]{16,}/,
	/^xai-[A-Za-z0-9_-]{16,}/,
	/^AIza[A-Za-z0-9_-]{20,}/,
	/^gsk_[A-Za-z0-9]{16,}/,
	/^hf_[A-Za-z0-9]{16,}/,
	/^xox[abprs]-[A-Za-z0-9-]{16,}/, // Slack
	/^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}/, // Stripe
	/^AKIA[A-Z0-9]{16}$/, // AWS access key id
	/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
];

/** Long, space-free, mixed-class tokens: letters and digits (or symbols) together. */
const LONG_TOKEN_MIN = 24;

export function looksLikeSecret(text: unknown): boolean {
	if (typeof text !== "string") return false;
	const t = text.trim();
	if (t.length < 8) return false;
	if (KEY_SHAPES.some((re) => re.test(t))) return true;
	if (t.length >= LONG_TOKEN_MIN && !/\s/.test(t)) {
		const mixed = (x: string) => /[A-Za-z]/.test(x) && /[0-9]/.test(x);
		const segs = t.split(/[-_.]/).filter(Boolean);
		if (segs.length <= 1) {
			// One unbroken run of letters and digits: key-shaped. A plain long word is a name.
			if (mixed(t)) return true;
		} else {
			// Hyphenated words with a number in them ("Engineer2-Quality-Assurance-Bot",
			// "my-tab-2026-release-notes") are names. Keys carry long mixed segments,
			// or several mixed segments (UUID style).
			if (segs.some((x) => x.length >= 16 && mixed(x))) return true;
			if (segs.filter((x) => x.length >= 4 && mixed(x)).length >= 2) return true;
		}
	}
	return false;
}

/** One line, plain words, no value in it. */
export const SECRET_NAME_REFUSAL =
	"That looks like a key, so I did not save it as a name. Add keys with /apikeys, on a masked screen.";

export const SECRET_NAME_RESET_NOTICE =
	"A saved name looked like a key, so I reset it. If it was a real key, revoke it with your provider.";
