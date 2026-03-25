/**
 * Fluent SQLite query builder for the memory package.
 * Zero external dependencies. Supports SELECT/INSERT/UPDATE/DELETE,
 * parameter binding, JOIN, and FTS5 MATCH.
 */

export type Param = string | number | boolean | null | Uint8Array;
export type JoinType = "INNER" | "LEFT" | "LEFT OUTER" | "CROSS";

interface JoinClause { type: JoinType; table: string; on: string; }
interface OrderClause { column: string; direction: "ASC" | "DESC"; }
type QueryMode = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/**
 * Fluent SQLite query builder.
 *
 * Example:
 *   const { sql, params } = new QueryBuilder()
 *     .select("id", "content")
 *     .from("memories")
 *     .where("user_id = ?", userId)
 *     .orderBy("created_at", "DESC")
 *     .limit(10)
 *     .build();
 */
export class QueryBuilder {
  private mode: QueryMode = "SELECT";
  private _columns: string[] = [];
  private _distinct = false;
  private _table = "";
  private _joins: JoinClause[] = [];
  private _whereClauses: string[] = [];
  private _whereParams: Param[] = [];
  private _ftsTable = "";
  private _ftsQuery = "";
  private _groupBy: string[] = [];
  private _havingClauses: string[] = [];
  private _havingParams: Param[] = [];
  private _orderBy: OrderClause[] = [];
  private _limit: number | null = null;
  private _offset: number | null = null;
  private _insertColumns: string[] = [];
  private _insertValues: Param[] = [];
  private _orReplace = false;
  private _setClauses: string[] = [];
  private _setParams: Param[] = [];
  private _returning: string[] = [];

  /** Start a SELECT query. Defaults to "*" if no columns given. */
  select(...columns: string[]): this {
    this.mode = "SELECT";
    this._columns = columns.length > 0 ? columns : ["*"];
    return this;
  }

  distinct(): this { this._distinct = true; return this; }

  /** Set primary table. Required for all query modes. */
  from(table: string): this { this._table = table; return this; }

  /** Start an INSERT INTO query. */
  insertInto(table: string, columns: string[], values: Param[]): this {
    this.mode = "INSERT";
    this._table = table;
    this._insertColumns = columns;
    this._insertValues = values;
    return this;
  }

  /** Use INSERT OR REPLACE semantics. */
  orReplace(): this { this._orReplace = true; return this; }

  /** Start an UPDATE query. */
  update(table: string): this { this.mode = "UPDATE"; this._table = table; return this; }

  /**
   * Add a SET clause.
   * - set("col", value)  =>  col = ?
   * - set("col = datetime('now')")  =>  raw expression
   */
  set(columnOrExpr: string, value?: Param): this {
    if (columnOrExpr.includes("=") || value === undefined) {
      this._setClauses.push(columnOrExpr);
    } else {
      this._setClauses.push(`${columnOrExpr} = ?`);
      this._setParams.push(value);
    }
    return this;
  }

  /** Start a DELETE FROM query. */
  deleteFrom(table: string): this { this.mode = "DELETE"; this._table = table; return this; }

  /** Add a JOIN clause. Defaults to INNER JOIN. */
  join(table: string, on: string, type: JoinType = "INNER"): this {
    this._joins.push({ type, table, on });
    return this;
  }

  leftJoin(table: string, on: string): this { return this.join(table, on, "LEFT"); }

  /**
   * Add a WHERE condition. Multiple calls are AND-ed.
   * Pass ? placeholder values as rest params.
   */
  where(condition: string, ...params: Param[]): this {
    this._whereClauses.push(condition);
    this._whereParams.push(...params);
    return this;
  }

  /** WHERE column IN (?, ?, ...) */
  whereIn(column: string, values: Param[]): this {
    if (values.length === 0) { this._whereClauses.push("1 = 0"); return this; }
    const ph = values.map(() => "?").join(", ");
    this._whereClauses.push(`${column} IN (${ph})`);
    this._whereParams.push(...values);
    return this;
  }

  whereNull(column: string): this { this._whereClauses.push(`${column} IS NULL`); return this; }
  whereNotNull(column: string): this { this._whereClauses.push(`${column} IS NOT NULL`); return this; }

  /**
   * Add an FTS5 MATCH condition.
   * Appends `<ftsTable> MATCH ?` to the WHERE clause.
   */
  ftsMatch(ftsTable: string, query: string): this {
    this._ftsTable = ftsTable;
    this._ftsQuery = query;
    return this;
  }

  groupBy(...columns: string[]): this { this._groupBy.push(...columns); return this; }

  having(condition: string, ...params: Param[]): this {
    this._havingClauses.push(condition);
    this._havingParams.push(...params);
    return this;
  }

  orderBy(column: string, direction: "ASC" | "DESC" = "ASC"): this {
    this._orderBy.push({ column, direction });
    return this;
  }

  limit(n: number): this { this._limit = n; return this; }
  offset(n: number): this { this._offset = n; return this; }

  /** SQLite RETURNING clause for INSERT/UPDATE/DELETE. Defaults to *. */
  returning(...columns: string[]): this {
    this._returning = columns.length > 0 ? columns : ["*"];
    return this;
  }

  /** Build and return the SQL string plus bound parameter array. */
  build(): { sql: string; params: Param[] } {
    switch (this.mode) {
      case "SELECT": return this._buildSelect();
      case "INSERT": return this._buildInsert();
      case "UPDATE": return this._buildUpdate();
      case "DELETE": return this._buildDelete();
    }
  }

  private _buildSelect(): { sql: string; params: Param[] } {
    if (!this._table) throw new Error("QueryBuilder: .from(table) is required for SELECT");
    const params: Param[] = [];
    const parts: string[] = [];
    const d = this._distinct ? "DISTINCT " : "";
    const cols = this._columns.length > 0 ? this._columns.join(", ") : "*";
    parts.push(`SELECT ${d}${cols} FROM ${this._table}`);
    for (const j of this._joins) parts.push(`${j.type} JOIN ${j.table} ON ${j.on}`);
    const wp = [...this._whereClauses];
    const wpc = [...this._whereParams];
    if (this._ftsTable && this._ftsQuery) { wp.push(`${this._ftsTable} MATCH ?`); wpc.push(this._ftsQuery); }
    if (wp.length > 0) { parts.push(`WHERE ${wp.map((c) => `(${c})`).join(" AND ")}`); params.push(...wpc); }
    if (this._groupBy.length > 0) parts.push(`GROUP BY ${this._groupBy.join(", ")}`);
    if (this._havingClauses.length > 0) {
      parts.push(`HAVING ${this._havingClauses.map((c) => `(${c})`).join(" AND ")}`);
      params.push(...this._havingParams);
    }
    if (this._orderBy.length > 0) parts.push(`ORDER BY ${this._orderBy.map((o) => `${o.column} ${o.direction}`).join(", ")}`);
    if (this._limit !== null) parts.push(`LIMIT ${this._limit}`);
    if (this._offset !== null) parts.push(`OFFSET ${this._offset}`);
    return { sql: parts.join(" "), params };
  }

  private _buildInsert(): { sql: string; params: Param[] } {
    if (!this._table) throw new Error("QueryBuilder: table is required for INSERT");
    if (this._insertColumns.length === 0) throw new Error("QueryBuilder: columns are required for INSERT");
    const kw = this._orReplace ? "INSERT OR REPLACE" : "INSERT";
    const cols = this._insertColumns.join(", ");
    const ph = this._insertValues.map(() => "?").join(", ");
    let sql = `${kw} INTO ${this._table} (${cols}) VALUES (${ph})`;
    const params: Param[] = [...this._insertValues];
    if (this._returning.length > 0) sql += ` RETURNING ${this._returning.join(", ")}`;
    return { sql, params };
  }

  private _buildUpdate(): { sql: string; params: Param[] } {
    if (!this._table) throw new Error("QueryBuilder: table is required for UPDATE");
    if (this._setClauses.length === 0) throw new Error("QueryBuilder: at least one .set() call is required for UPDATE");
    const params: Param[] = [];
    let sql = `UPDATE ${this._table} SET ${this._setClauses.join(", ")}`;
    params.push(...this._setParams);
    if (this._whereClauses.length > 0) {
      sql += ` WHERE ${this._whereClauses.map((c) => `(${c})`).join(" AND ")}`;
      params.push(...this._whereParams);
    }
    if (this._returning.length > 0) sql += ` RETURNING ${this._returning.join(", ")}`;
    return { sql, params };
  }

  private _buildDelete(): { sql: string; params: Param[] } {
    if (!this._table) throw new Error("QueryBuilder: table is required for DELETE");
    const params: Param[] = [];
    let sql = `DELETE FROM ${this._table}`;
    if (this._whereClauses.length > 0) {
      sql += ` WHERE ${this._whereClauses.map((c) => `(${c})`).join(" AND ")}`;
      params.push(...this._whereParams);
    }
    if (this._returning.length > 0) sql += ` RETURNING ${this._returning.join(", ")}`;
    return { sql, params };
  }

  /** Shallow clone for building query variants from a common base. */
  clone(): QueryBuilder {
    return Object.assign(new QueryBuilder(), {
      mode: this.mode, _columns: [...this._columns], _distinct: this._distinct, _table: this._table,
      _joins: [...this._joins], _whereClauses: [...this._whereClauses], _whereParams: [...this._whereParams],
      _ftsTable: this._ftsTable, _ftsQuery: this._ftsQuery, _groupBy: [...this._groupBy],
      _havingClauses: [...this._havingClauses], _havingParams: [...this._havingParams],
      _orderBy: [...this._orderBy], _limit: this._limit, _offset: this._offset,
      _insertColumns: [...this._insertColumns], _insertValues: [...this._insertValues],
      _orReplace: this._orReplace, _setClauses: [...this._setClauses], _setParams: [...this._setParams],
      _returning: [...this._returning],
    });
  }

  reset(): this {
    this.mode = "SELECT"; this._columns = []; this._distinct = false; this._table = ""; this._joins = [];
    this._whereClauses = []; this._whereParams = []; this._ftsTable = ""; this._ftsQuery = "";
    this._groupBy = []; this._havingClauses = []; this._havingParams = []; this._orderBy = [];
    this._limit = null; this._offset = null; this._insertColumns = []; this._insertValues = [];
    this._orReplace = false; this._setClauses = []; this._setParams = []; this._returning = [];
    return this;
  }
}
