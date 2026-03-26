/**
 * Builds Content-Security-Policy headers.
 */
export class CSPBuilder {
  private directives: Record<string, string[]> = {};

  /**
   * Sets the default-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  defaultSrc(...values: string[]): this {
    this.directives['default-src'] = values;
    return this;
  }

  /**
   * Sets the script-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  scriptSrc(...values: string[]): this {
    this.directives['script-src'] = values;
    return this;
  }

  /**
   * Sets the style-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  styleSrc(...values: string[]): this {
    this.directives['style-src'] = values;
    return this;
  }

  /**
   * Sets the img-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  imgSrc(...values: string[]): this {
    this.directives['img-src'] = values;
    return this;
  }

  /**
   * Sets the connect-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  connectSrc(...values: string[]): this {
    this.directives['connect-src'] = values;
    return this;
  }

  /**
   * Sets the font-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  fontSrc(...values: string[]): this {
    this.directives['font-src'] = values;
    return this;
  }

  /**
   * Sets the media-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  mediaSrc(...values: string[]): this {
    this.directives['media-src'] = values;
    return this;
  }

  /**
   * Sets the object-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  objectSrc(...values: string[]): this {
    this.directives['object-src'] = values;
    return this;
  }

  /**
   * Sets the frame-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  frameSrc(...values: string[]): this {
    this.directives['frame-src'] = values;
    return this;
  }

  /**
   * Sets the child-src directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  childSrc(...values: string[]): this {
    this.directives['child-src'] = values;
    return this;
  }

  /**
   * Sets the sandbox directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  sandbox(...values: string[]): this {
    this.directives['sandbox'] = values;
    return this;
  }

  /**
   * Sets the report-uri directive.
   * @param values - Values for the directive.
   * @returns This instance for chaining.
   */
  reportUri(...values: string[]): this {
    this.directives['report-uri'] = values;
    return this;
  }

  /**
   * Generates a random nonce for inline scripts.
   * @returns A base64-encoded nonce string.
   */
  nonce(): string {
    const array = new Uint32Array(4);
    window.crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array));
  }

  /**
   * Generates the Content-Security-Policy header string.
   * @returns The header value.
   */
  toString(): string {
    return Object.entries(this.directives)
      .map(([directive, values]) => `${directive} ${values.join(' ')}`)
      .join('; ');
  }

  /**
   * Generates the <meta> tag content for CSP.
   * @returns The meta tag content.
   */
  toMeta(): string {
    return `content="${this.toString()}"`;
  }
}