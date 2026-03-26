/**
 * Generates an INSERT ... ON CONFLICT DO UPDATE statement for PostgreSQL and SQLite.
 * @param table - The table name.
 * @param rows - Array of objects representing the rows to insert.
 * @param conflictColumns - Columns to check for conflicts.
 * @param updateColumns - Columns to update on conflict.
 * @returns An object containing the SQL statement and parameters.
 */
export function upsert(table: string, rows: any[], conflictColumns: string[], updateColumns: string[]): { sql: string; params: any[] } {
   // Validate that all conflict columns are present in each row
   for (const row of rows) {
      for (const col of conflictColumns) {
         if (!(col in row)) {
            throw new Error(`Conflict column ${col} not found in row`);
         }
      }
   }

   // Extract columns from the first row
   const columns = Object.keys(rows[0]);

   // Generate values placeholders
   const values = rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');

   // Generate ON CONFLICT clause
   const conflictClause = `ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${updateColumns.map(col => `${col} = excluded.${col}`).join(', ')}`;

   // Build SQL
   const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values} ${conflictClause}`;

   // Collect parameters
   const params = rows.flatMap(row => columns.map(col => row[col]));

   return { sql, params };
}