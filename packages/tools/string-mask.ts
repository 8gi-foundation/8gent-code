/**
 * string-mask.ts
 *
 * Format-preserving string masking for sensitive data.
 * Masks emails, phones, credit cards, API keys, and arbitrary strings
 * while preserving enough context to identify the value.
 */

export interface MaskOptions {
  /** Number of characters to reveal at the start. Default: 1 */
  showStart?: number;
  /** Number of characters to reveal at the end. Default: 1 */
  showEnd?: number;
  /** Character to use for masking. Default: '*' */
  maskChar?: string;
}

/**
 * Generic format-preserving mask. Reveals first/last N chars, masks the rest.
 *
 * mask("supersecret")           -> "s*********t"
 * mask("hello", { showEnd: 2 }) -> "h***lo"
 */
export function mask(str: string, options: MaskOptions = {}): string {
  const { showStart = 1, showEnd = 1, maskChar = "*" } = options;

  if (!str || typeof str !== "string") return "";

  const len = str.length;

  if (len <= showStart + showEnd) {
    return maskChar.repeat(len);
  }

  const start = str.slice(0, showStart);
  const end = showEnd > 0 ? str.slice(-showEnd) : "";
  const middle = maskChar.repeat(len - showStart - showEnd);

  return `${start}${middle}${end}`;
}

/**
 * Mask an email address while preserving structure.
 *
 * maskEmail("user@example.com")  -> "u***@e******.com"
 * maskEmail("ab@cd.io")          -> "a*@c*.io"
 */
export function maskEmail(email: string, maskChar = "*"): string {
  if (!email || typeof email !== "string") return "";

  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return mask(email, { maskChar });

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  const dotIndex = domain.lastIndexOf(".");
  const domainName = dotIndex !== -1 ? domain.slice(0, dotIndex) : domain;
  const tld = dotIndex !== -1 ? domain.slice(dotIndex) : "";

  const maskedLocal = mask(local, { showStart: 1, showEnd: 0, maskChar });
  const maskedDomain = mask(domainName, { showStart: 1, showEnd: 0, maskChar });

  return `${maskedLocal}@${maskedDomain}${tld}`;
}

/**
 * Mask a phone number while preserving length and leading/trailing digits.
 * Strips non-digit chars, masks middle, re-inserts separators.
 *
 * maskPhone("+1 555-867-5309") -> "+1 ***-***-5309"
 * maskPhone("0867530900")      -> "0*******00"
 */
export function maskPhone(phone: string, maskChar = "*"): string {
  if (!phone || typeof phone !== "string") return "";

  let result = "";
  let digitCount = 0;
  const digits: string[] = [];

  for (const ch of phone) {
    if (/\d/.test(ch)) digits.push(ch);
  }

  const total = digits.length;
  const showStart = 1;
  const showEnd = Math.min(4, total);

  let digitIdx = 0;
  for (const ch of phone) {
    if (/\d/.test(ch)) {
      const pos = digitIdx;
      digitIdx++;
      if (pos < showStart || pos >= total - showEnd) {
        result += ch;
      } else {
        result += maskChar;
      }
      digitCount++;
    } else {
      result += ch;
    }
  }

  void digitCount;
  return result;
}

/**
 * Mask a credit/debit card number.
 * Shows last 4 digits only, preserves separators.
 *
 * maskCard("4242 4242 4242 4242") -> "**** **** **** 4242"
 * maskCard("4111111111111111")    -> "************1111"
 */
export function maskCard(card: string, maskChar = "*"): string {
  if (!card || typeof card !== "string") return "";

  const digits: string[] = [];
  for (const ch of card) {
    if (/\d/.test(ch)) digits.push(ch);
  }

  const total = digits.length;
  const showEnd = Math.min(4, total);

  let result = "";
  let digitIdx = 0;

  for (const ch of card) {
    if (/\d/.test(ch)) {
      const pos = digitIdx;
      digitIdx++;
      result += pos >= total - showEnd ? ch : maskChar;
    } else {
      result += ch;
    }
  }

  return result;
}

/**
 * Mask an API key, token, or secret.
 * Shows first 4 and last 4 chars, masks the rest.
 *
 * maskApiKey("sk-abc123xyz789def456") -> "sk-a***********f456"
 * maskApiKey("short")                 -> "*****"
 */
export function maskApiKey(key: string, maskChar = "*"): string {
  if (!key || typeof key !== "string") return "";

  return mask(key, { showStart: 4, showEnd: 4, maskChar });
}
