/**
 * Raised when memory recall fails, as distinct from recalling nothing.
 *
 * The distinction matters because the two are otherwise identical to every
 * caller: an empty array and a failed query both arrive as "no memories", and an
 * agent reasoning on a false world state will re-learn what it already knows
 * without any sign that anything went wrong.
 *
 * Deliberately its own class rather than an import from the admission gate, so
 * the read path does not depend on a write-path module being present.
 */
export class MemoryRecallError extends Error {
	/** The underlying failure, kept so a caller can log or rethrow the cause. */
	readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "MemoryRecallError";
		this.cause = cause;
	}
}
