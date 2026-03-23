/**
 * Tenant Isolation for Memory System
 *
 * Every memory query MUST go through tenantWhere() to prevent cross-user leakage.
 * This module enforces per-user, per-organization, and per-project memory scoping
 * using parameterized SQL to prevent injection.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface TenantScope {
  userId: string;
  organizationId?: string;
  projectId?: string;
}

export interface TenantClause {
  sql: string;
  params: string[];
}

// ── Query Scoping ─────────────────────────────────────────────────────

/**
 * Build SQL WHERE clause fragment for tenant-scoped queries.
 * Returns both the SQL string (with ? placeholders) and the parameter values.
 *
 * Usage:
 *   const { sql, params } = tenantWhere(scope);
 *   db.prepare(`SELECT * FROM memories WHERE deleted_at IS NULL ${sql}`).all(...params);
 */
export function tenantWhere(scope: TenantScope): TenantClause {
  const conditions: string[] = [];
  const params: string[] = [];

  // userId is always required - this is the primary isolation boundary
  conditions.push("AND json_extract(data, '$.userId') = ?");
  params.push(scope.userId);

  if (scope.organizationId) {
    conditions.push("AND json_extract(data, '$.organizationId') = ?");
    params.push(scope.organizationId);
  }

  if (scope.projectId) {
    conditions.push("AND json_extract(data, '$.projectId') = ?");
    params.push(scope.projectId);
  }

  return {
    sql: conditions.join(" "),
    params,
  };
}

// ── Validation ────────────────────────────────────────────────────────

/**
 * Validate that a memory record belongs to the given tenant before returning it.
 * Use this as a defense-in-depth check after SQL queries.
 */
export function validateTenant(memory: Record<string, unknown>, scope: TenantScope): boolean {
  if (memory.userId !== scope.userId) return false;

  if (scope.organizationId && memory.organizationId !== scope.organizationId) {
    return false;
  }

  if (scope.projectId && memory.projectId !== scope.projectId) {
    return false;
  }

  return true;
}

// ── Record Decoration ─────────────────────────────────────────────────

/**
 * Add tenant columns to a memory record before insert.
 * Ensures every memory is tagged with its owner's scope.
 */
export function applyTenantScope(
  record: Record<string, unknown>,
  scope: TenantScope
): Record<string, unknown> {
  return {
    ...record,
    userId: scope.userId,
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  };
}
