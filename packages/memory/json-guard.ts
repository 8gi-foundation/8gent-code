/**
 * JSONB Double-Encoding Guard
 *
 * Prevents double-encoding on write and heals double-encoded data on read.
 *
 * Problem: If a Memory object's fields are already JSON strings, JSON.stringify
 * wraps them in another layer of escaping. On read, JSON.parse only peels one
 * layer, leaving inner fields as strings instead of objects.
 *
 * safeJsonStringify: Before serialising, checks if the value is already a JSON
 *   string representing an object/array and unwraps it first.
 *
 * safeJsonParse: After deserialising, if the result is still a string that
 *   parses as JSON, keeps unwrapping up to 2 additional layers (healing
 *   accumulated encoding).
 */

/**
 * Safely stringify a value for storage. If the value is a string that parses
 * as an object or array, stringify the parsed result instead (unwrap one layer).
 */
export function safeJsonStringify(value: unknown): string {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed !== null && typeof parsed === "object") {
				return JSON.stringify(parsed);
			}
		} catch {
			// Not valid JSON — stringify as normal
		}
	}
	return JSON.stringify(value);
}

/**
 * Safely parse a JSON string. If the first parse yields a string that itself
 * parses as valid JSON, keep unwrapping up to 2 additional levels. This heals
 * data that was double- or triple-encoded.
 *
 * Stops when the result is a non-string (object/array/number/boolean/null)
 * or when the string is not valid JSON (a plain text value like "hello world").
 */
export function safeJsonParse<T>(raw: string): T {
	let result: unknown = JSON.parse(raw);

	// Unwrap up to 2 additional layers of string-encoded JSON
	for (let i = 0; i < 2; i++) {
		if (typeof result !== "string") break;
		try {
			const inner = JSON.parse(result);
			// If the inner parse produced an object/array, unwrap and continue
			// If it produced another string, unwrap and continue (might be another layer)
			// If it produced a primitive (number/boolean/null), keep the string form
			// to avoid accidentally converting "123" to 123
			if (
				inner !== null &&
				(typeof inner === "object" || typeof inner === "string")
			) {
				result = inner;
			} else {
				break;
			}
		} catch {
			break; // Not valid JSON — stop unwrapping
		}
	}

	return result as T;
}
