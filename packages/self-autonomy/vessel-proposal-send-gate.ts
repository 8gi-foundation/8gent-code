/**
 * Opt-in send gate for vessel proposals (epic #4937, issue #4937).
 *
 * A proposal may be offered for sending only when a person saw the exact
 * text and confirmed that same text. Default is No: unattended runs never
 * send, a missing confirmation never sends, and a changed text never sends.
 *
 * Pure decision. No network, no file write, no GitHub call.
 */
export interface VesselProposalSendInput {
	unattended: boolean;
	shownText: string;
	confirmedText: string | null;
}

export function mayOfferSend(input: VesselProposalSendInput): boolean {
	if (input.unattended !== false) return false;
	if (typeof input.shownText !== "string" || input.shownText === "") return false;
	if (input.confirmedText === null || typeof input.confirmedText !== "string") {
		return false;
	}
	return input.confirmedText === input.shownText;
}
