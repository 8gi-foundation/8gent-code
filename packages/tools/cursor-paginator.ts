/**
 * Encodes a cursor object into a base64 string.
 * @param cursor - The cursor object containing field and value.
 * @returns The encoded base64 string.
 */
export function encode(cursor: { field: string; value: any }): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

/**
 * Decodes a base64 string into a cursor object.
 * @param token - The base64 encoded string.
 * @returns The decoded cursor object.
 */
export function decode(token: string): { field: string; value: any } {
  return JSON.parse(Buffer.from(token, 'base64').toString());
}

/**
 * Builds a SQL WHERE clause based on the cursor and direction.
 * @param cursor - The decoded cursor object.
 * @param direction - 'next' or 'prev' to determine the comparison operator.
 * @returns The SQL WHERE fragment.
 */
export function buildWhere(cursor: { field: string; value: any }, direction: 'next' | 'prev'): string {
  const op = direction === 'next' ? '>' : '<';
  return `${cursor.field} ${op} ${cursor.value}`;
}

/**
 * Represents a paginated result.
 * @template T - The type of items in the result.
 */
export interface PageResult<T> {
  items: T[];
  nextCursor: string;
  prevCursor: string;
  hasMore: boolean;
}