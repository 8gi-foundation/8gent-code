/**
 * Trace context type.
 */
type Trace = {
  traceId: string;
  spanId: string;
  flags: string;
  version: string;
};

/**
 * Generates a new trace and span ID.
 * @returns {Trace} A new trace object with traceId, spanId, flags, and version.
 */
function generate(): Trace {
  return {
    traceId: generateHex(32),
    spanId: generateHex(16),
    flags: '00',
    version: '00'
  };
}

/**
 * Parses a traceparent header.
 * @param {string} header - The traceparent header string.
 * @returns {Trace} Parsed trace context.
 * @throws {Error} If the header is invalid.
 */
function parse(header: string): Trace {
  const parts = header.split('-');
  if (parts.length !== 4) {
    throw new Error('Invalid traceparent header');
  }
  const [version, traceId, spanId, flags] = parts;
  if (version.length !== 2 || traceId.length !== 32 || spanId.length !== 16 || flags.length !== 2) {
    throw new Error('Invalid traceparent header');
  }
  return { version, traceId, spanId, flags };
}

/**
 * Formats a trace context into a traceparent header string.
 * @param {Trace} trace - The trace context object.
 * @returns {string} Formatted traceparent header.
 */
function format(trace: Trace): string {
  return `${trace.version}-${trace.traceId}-${trace.spanId}-${trace.flags}`;
}

/**
 * Creates a child span from a parent trace.
 * @param {Trace} parent - The parent trace context.
 * @returns {Trace} A new trace context with a new span ID.
 */
function child(parent: Trace): Trace {
  return {
    ...parent,
    spanId: generateHex(16)
  };
}

/**
 * Generates a random hex string of specified length.
 * @param {number} length - Length of the hex string (in characters).
 * @returns {string} Random hex string.
 */
function generateHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export { generate, parse, format, child, Trace };