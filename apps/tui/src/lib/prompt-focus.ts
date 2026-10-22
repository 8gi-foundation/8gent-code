/**
 * Who owns the keyboard (0.20.12 regression, Artale's report).
 *
 * 0.20.12 made the prompt live only in "chat tab in chat mode" and onboarding.
 * Any other view left it deaf, with nothing on screen to say why. The rule is
 * inverted here: the prompt is live unless a view is on the explicit list below.
 * A new viewMode therefore fails open, which is the safe direction.
 */

/** Views drawn over the chat that read their own keys. Esc closes each. */
export const KEYBOARD_VIEWS: ReadonlySet<string> = new Set([
	"model-select",
	"provider-select",
	"theme-select",
	"session-picker",
	"session-tree",
	"keys",
]);

/** The one line every keyboard-owning view shows, so the way back is always visible. */
export const ESC_RETURNS_LINE = "Esc returns to the prompt";

export interface PromptFocusState {
	viewMode: string;
	/** A non-chat tab body is drawn and hides the prompt, so it owns the keys. */
	tabBodyShown: boolean;
	isBubbleNavMode: boolean;
	paletteOpen: boolean;
	djKeys: boolean;
	onboardingSelectChoices: boolean;
}

export function promptIsLive(s: PromptFocusState): boolean {
	if (KEYBOARD_VIEWS.has(s.viewMode)) return false;
	if (s.viewMode === "onboarding" && s.onboardingSelectChoices) return false;
	return !s.tabBodyShown && !s.isBubbleNavMode && !s.paletteOpen && !s.djKeys;
}

/**
 * The automatic provider picker (no chat model anywhere) is a question, and with
 * exactly one keyed hosted provider there is nothing to ask (#4720): the first
 * turn switches to it, or says why it cannot. /provider still opens it by hand.
 */
export function mayAutoOpenProviderPicker(keyedHostedProviders: readonly string[]): boolean {
	return keyedHostedProviders.length !== 1;
}
