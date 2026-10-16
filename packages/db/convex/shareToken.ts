// Share-link token generator. Plain helper module (no Convex functions).
// Uses Web Crypto, available in the Convex runtime and in Bun/Node.

// 32 symbols, so `byte & 31` maps each random byte with no modulo bias.
export const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** URL-safe random token, 24 chars by default (120 bits). */
export function makeToken(len = 24): string {
	const bytes = new Uint8Array(len);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < len; i++) out += TOKEN_ALPHABET[bytes[i] & 31];
	return out;
}
