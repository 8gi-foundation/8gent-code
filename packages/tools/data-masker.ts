/**
 * data-masker.ts
 * Deep-traverses objects and masks sensitive fields for safe logging.
 * No dependencies - pure TypeScript.
 */

export interface MaskOptions {
  /** Patterns to match against field names (case-insensitive). Default: built-in sensitive list. */
  patterns?: (string | RegExp)[];
  /** Character to use for masking. Default: '*' */
  maskChar?: string;
  /** Show this many chars at the end of the original value. 0 = full mask. Default: 4 */
  showLastChars?: number;
  /** Max recursion depth. Default: 20 */
  maxDepth?: number;
}

const DEFAULT_PATTERNS: RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /\bkey\b/i,
  /apikey/i,
  /api_key/i,
  /auth/i,
  /credential/i,
  /private/i,
  /ssn/i,
  /credit.?card/i,
  /cvv/i,
  /pin\b/i,
];

const DEFAULT_MASK_CHAR = '*';
const DEFAULT_SHOW_LAST = 4;
const DEFAULT_MAX_DEPTH = 20;

function isSensitiveKey(key: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((p) =>
    typeof p === 'string' ? key.toLowerCase().includes(p.toLowerCase()) : p.test(key)
  );
}

function maskValue(value: unknown, maskChar: string, showLast: number): string {
  const str = typeof value === 'string' ? value : String(value);
  const type = typeof value !== 'string' ? `[${typeof value}]` : '';

  if (str.length === 0) return type + '***';

  if (showLast > 0 && str.length > showLast) {
    const visible = str.slice(-showLast);
    const masked = maskChar.repeat(Math.min(str.length - showLast, 8));
    return type + masked + visible;
  }

  return type + maskChar.repeat(Math.min(str.length, 8));
}

function deepMask(
  obj: unknown,
  patterns: (string | RegExp)[],
  maskChar: string,
  showLast: number,
  depth: number,
  maxDepth: number
): unknown {
  if (depth > maxDepth) return '[max depth exceeded]';
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => deepMask(item, patterns, maskChar, showLast, depth + 1, maxDepth));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(k, patterns)) {
        if (v !== null && v !== undefined) {
          result[k] = maskValue(v, maskChar, showLast);
        } else {
          result[k] = v;
        }
      } else {
        result[k] = deepMask(v, patterns, maskChar, showLast, depth + 1, maxDepth);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Mask sensitive fields in an object for safe logging.
 *
 * @param obj - Any value to mask. Non-objects are returned as-is.
 * @param options - Optional configuration.
 * @returns A new object with sensitive field values replaced by masked strings.
 *
 * @example
 * maskSensitive({ user: 'alice', password: 'hunter2', token: 'abc123xyz' })
 * // => { user: 'alice', password: '****er2', token: '****3xyz' }
 */
export function maskSensitive(obj: unknown, options: MaskOptions = {}): unknown {
  const patterns: (string | RegExp)[] = options.patterns ?? DEFAULT_PATTERNS;
  const maskChar = options.maskChar ?? DEFAULT_MASK_CHAR;
  const showLast = options.showLastChars ?? DEFAULT_SHOW_LAST;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  return deepMask(obj, patterns, maskChar, showLast, 0, maxDepth);
}
