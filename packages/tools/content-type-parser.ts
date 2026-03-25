/**
 * HTTP Content-Type header parser.
 * Parses Content-Type headers into structured components and provides
 * format and detection helpers.
 */

export interface ParsedContentType {
  type: string;
  subtype: string;
  parameters: Record<string, string>;
  charset: string | undefined;
  boundary: string | undefined;
}

/**
 * Parses an HTTP Content-Type header string into structured components.
 *
 * Examples:
 *   "text/html; charset=UTF-8" -> { type: "text", subtype: "html", charset: "UTF-8", ... }
 *   "multipart/form-data; boundary=----WebKitFormBoundary" -> { boundary: "----WebKit...", ... }
 *   "application/json" -> { type: "application", subtype: "json", ... }
 */
export function parseContentType(header: string): ParsedContentType {
  if (!header || typeof header !== "string") {
    return {
      type: "",
      subtype: "",
      parameters: {},
      charset: undefined,
      boundary: undefined,
    };
  }

  const parts = header.split(";").map((s) => s.trim());
  const mediaType = parts[0].toLowerCase();
  const slashIndex = mediaType.indexOf("/");

  const type = slashIndex >= 0 ? mediaType.slice(0, slashIndex) : mediaType;
  const subtype = slashIndex >= 0 ? mediaType.slice(slashIndex + 1) : "";

  const parameters: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const param = parts[i];
    const eqIndex = param.indexOf("=");
    if (eqIndex < 0) continue;

    const key = param.slice(0, eqIndex).trim().toLowerCase();
    let value = param.slice(eqIndex + 1).trim();

    // Strip surrounding quotes if present
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    parameters[key] = value;
  }

  const charset = parameters["charset"];
  const boundary = parameters["boundary"];

  return { type, subtype, parameters, charset, boundary };
}

/**
 * Formats a ParsedContentType back into a canonical Content-Type header string.
 *
 * Example:
 *   { type: "text", subtype: "html", parameters: { charset: "UTF-8" } }
 *   -> "text/html; charset=UTF-8"
 */
export function format(parsed: ParsedContentType): string {
  if (!parsed.type) return "";

  let result = parsed.subtype
    ? `${parsed.type}/${parsed.subtype}`
    : parsed.type;

  for (const [key, value] of Object.entries(parsed.parameters)) {
    // Quote values that contain special characters
    const needsQuotes = /[^\w\-.]/.test(value);
    result += needsQuotes ? `; ${key}="${value}"` : `; ${key}=${value}`;
  }

  return result;
}

/**
 * Returns true if the Content-Type header represents JSON data.
 * Matches: application/json, application/*+json
 */
export function isJson(header: string): boolean {
  const { type, subtype } = parseContentType(header);
  return type === "application" && (subtype === "json" || subtype.endsWith("+json"));
}

/**
 * Returns true if the Content-Type header represents any text/* type.
 * Matches: text/plain, text/html, text/csv, text/xml, etc.
 */
export function isText(header: string): boolean {
  const { type } = parseContentType(header);
  return type === "text";
}

/**
 * Returns true if the Content-Type header represents HTML content.
 * Matches: text/html only.
 */
export function isHtml(header: string): boolean {
  const { type, subtype } = parseContentType(header);
  return type === "text" && subtype === "html";
}

/**
 * Returns true if the Content-Type header represents XML content.
 * Matches: text/xml, application/xml, application/*+xml
 */
export function isXml(header: string): boolean {
  const { type, subtype } = parseContentType(header);
  return (
    (type === "text" && subtype === "xml") ||
    (type === "application" && (subtype === "xml" || subtype.endsWith("+xml")))
  );
}

/**
 * Returns true if the Content-Type header represents multipart form data.
 */
export function isMultipart(header: string): boolean {
  const { type } = parseContentType(header);
  return type === "multipart";
}
