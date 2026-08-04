/**
 * Id minting for Table entities.
 *
 * Channel ids  = "chan_" + 24 hex
 * Message ids  = "msg_"  + 24 hex
 *
 * 24 hex chars = 12 random bytes = 96 bits of entropy, derived from
 * crypto.randomUUID() (a v4 UUID, 122 bits of randomness) with the version
 * / variant separators stripped and truncated. Collision probability across
 * a single local workspace is negligible.
 */

import { randomUUID } from "node:crypto";

/** 24 hex chars from a fresh UUIDv4 (dashes removed, truncated). */
function hex24(): string {
	return randomUUID().replace(/-/g, "").slice(0, 24);
}

export function newChannelId(): string {
	return `chan_${hex24()}`;
}

export function newMessageId(): string {
	return `msg_${hex24()}`;
}

/** True if the string looks like a channel id we minted. */
export function isChannelId(id: string): boolean {
	return /^chan_[0-9a-f]{24}$/.test(id);
}

/** True if the string looks like a message id we minted. */
export function isMessageId(id: string): boolean {
	return /^msg_[0-9a-f]{24}$/.test(id);
}
