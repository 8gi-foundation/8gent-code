/**
 * Chat message ids. The transcript is a keyed list, so two messages that share
 * an id are drawn as one message twice and the other is dropped. `prefix-<ms>`
 * collides whenever two notices land in the same millisecond, which a resume
 * line plus the notices that mount beside it do on a slow phone (#4807). The
 * counter makes every id unique for the life of the process.
 */
let seq = 0;

export function messageId(prefix: string): string {
	return `${prefix}-${Date.now()}-${seq++}`;
}
