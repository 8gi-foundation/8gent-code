/**
 * Encodes an array of objects into a newline-delimited JSON string.
 * @param records - Array of objects to encode
 * @returns NDJSON string
 */
export function encode<T>(records: T[]): string {
  return records.map(JSON.stringify).join('\n');
}

/**
 * Decodes a newline-delimited JSON string into an array of objects.
 * @param text - NDJSON string to decode
 * @returns Array of parsed objects
 */
export function decode<T>(text: string): T[] {
  return text.split('\n').map(line => JSON.parse(line));
}

/**
 * Streams records from an NDJSON string, invoking callback per line.
 * @param text - NDJSON string to process
 * @param onRecord - Callback to handle each parsed record
 */
export function stream<T>(text: string, onRecord: (record: T) => void): void {
  text.split('\n').forEach(line => {
    try {
      onRecord(JSON.parse(line));
    } catch {
      // Ignore parsing errors
    }
  });
}

/**
 * Serializes a single object into a JSON string for NDJSON.
 * @param obj - Object to serialize
 * @returns JSON string
 */
export function encodeRecord<T>(obj: T): string {
  return JSON.stringify(obj);
}