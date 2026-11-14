/**
 * What voice mode shows and speaks for a model reply (#154).
 *
 * Marker tokens are stripped. A reply with nothing left stays empty: the voice
 * loop speaks nothing for an empty reply (silence is the default), and no
 * stock completion word is supplied in its place.
 */
export function voiceReplyText(response: string | null | undefined): string {
	return (response || "")
		.replace(/\[_EOT_\]/g, "")
		.replace(/<\|.*?\|>/g, "")
		.trim();
}
