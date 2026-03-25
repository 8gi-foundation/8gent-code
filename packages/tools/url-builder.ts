/**
 * Fluent URL builder with chainable API.
 * Handles path segments, query params, hash, auth, port, and proper encoding.
 */

export class UrlBuilder {
  private _base: string = "";
  private _pathSegments: string[] = [];
  private _query: Map<string, string[]> = new Map();
  private _hash: string = "";
  private _user: string = "";
  private _pass: string = "";
  private _port: number | null = null;

  constructor(base: string) {
    // Strip trailing slash from base
    this._base = base.replace(/\/+$/, "");
  }

  /**
   * Append a path segment. Handles leading/trailing slashes.
   */
  path(segment: string): this {
    // Normalize: strip leading/trailing slashes, then push
    const clean = segment.replace(/^\/+|\/+$/g, "");
    if (clean.length > 0) {
      this._pathSegments.push(clean);
    }
    return this;
  }

  /**
   * Add a query param. Supports multi-value keys by calling repeatedly.
   */
  query(key: string, value: string | number | boolean): this {
    const encodedKey = encodeURIComponent(String(key));
    const encodedVal = encodeURIComponent(String(value));
    const existing = this._query.get(encodedKey);
    if (existing) {
      existing.push(encodedVal);
    } else {
      this._query.set(encodedKey, [encodedVal]);
    }
    return this;
  }

  /**
   * Set the URL fragment (hash). Do not include the '#' prefix.
   */
  hash(fragment: string): this {
    this._hash = fragment;
    return this;
  }

  /**
   * Set HTTP Basic Auth credentials.
   */
  auth(user: string, pass: string): this {
    this._user = encodeURIComponent(user);
    this._pass = encodeURIComponent(pass);
    return this;
  }

  /**
   * Override the port. Pass null or 0 to clear.
   */
  port(n: number | null): this {
    this._port = n && n > 0 ? n : null;
    return this;
  }

  /**
   * Build and return the final URL string.
   */
  build(): string {
    let url = this._base;

    // Inject auth credentials if provided
    if (this._user) {
      const protocolEnd = url.indexOf("://");
      if (protocolEnd !== -1) {
        const protocol = url.slice(0, protocolEnd + 3);
        const rest = url.slice(protocolEnd + 3);
        const creds = this._pass
          ? `${this._user}:${this._pass}@`
          : `${this._user}@`;
        url = `${protocol}${creds}${rest}`;
      }
    }

    // Inject port if provided
    if (this._port !== null) {
      // Insert port after host (before any path)
      const protocolEnd = url.indexOf("://");
      if (protocolEnd !== -1) {
        const afterProtocol = url.slice(protocolEnd + 3);
        const slashIdx = afterProtocol.indexOf("/");
        const host =
          slashIdx === -1 ? afterProtocol : afterProtocol.slice(0, slashIdx);
        const rest = slashIdx === -1 ? "" : afterProtocol.slice(slashIdx);
        // Strip existing port if present
        const hostNoPort = host.replace(/:\d+$/, "");
        url = `${url.slice(0, protocolEnd + 3)}${hostNoPort}:${this._port}${rest}`;
      }
    }

    // Append path segments
    if (this._pathSegments.length > 0) {
      url = `${url}/${this._pathSegments.join("/")}`;
    }

    // Append query string
    if (this._query.size > 0) {
      const parts: string[] = [];
      for (const [key, values] of this._query) {
        for (const val of values) {
          parts.push(`${key}=${val}`);
        }
      }
      url = `${url}?${parts.join("&")}`;
    }

    // Append hash
    if (this._hash) {
      url = `${url}#${encodeURIComponent(this._hash)}`;
    }

    return url;
  }

  /**
   * Clone this builder so you can branch without mutating the original.
   */
  clone(): UrlBuilder {
    const copy = new UrlBuilder(this._base);
    copy._pathSegments = [...this._pathSegments];
    copy._query = new Map(
      [...this._query.entries()].map(([k, v]) => [k, [...v]])
    );
    copy._hash = this._hash;
    copy._user = this._user;
    copy._pass = this._pass;
    copy._port = this._port;
    return copy;
  }

  toString(): string {
    return this.build();
  }
}

/**
 * Factory shorthand. Returns a new UrlBuilder for the given base URL.
 *
 * @example
 * url("https://api.example.com")
 *   .path("v1").path("users")
 *   .query("page", 2)
 *   .query("limit", 50)
 *   .build();
 * // => "https://api.example.com/v1/users?page=2&limit=50"
 */
export function url(base: string): UrlBuilder {
  return new UrlBuilder(base);
}
