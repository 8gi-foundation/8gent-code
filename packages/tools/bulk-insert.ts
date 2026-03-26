/**
 * Splits rows into chunks of specified size.
 * @param rows - Array to split.
 * @param size - Size of each chunk.
 * @returns Array of chunks.
 */
export function chunk<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    result.push(rows.slice(i, i + size));
  }
  return result;
}

/**
 * Extracts values from rows according to specified columns.
 * @param rows - Rows to extract values from.
 * @param columns - Column names in order.
 * @returns Array of value arrays.
 */
export function toValues(rows: any[], columns: string[]): any[][] {
  return rows.map(row => columns.map(col => row[col]));
}

/**
 * Generates parameterized SQL INSERT statement.
 * @param table - Table name.
 * @param rows - Rows to insert.
 * @returns SQL INSERT statement.
 */
export function toInsertSQL(table: string, rows: any[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const valuesArrays = toValues(rows, columns);
  const values = valuesArrays.map(arr => 
    arr.map(v => v === undefined ? 'NULL' : JSON.stringify(v)).join(', ')
  );
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`;
}