/**
 * @8gent/control-plane — Tenant Management
 *
 * CRUD operations for tenant configurations, subdomain mapping,
 * and usage limit enforcement.
 */

import type { TenantConfig, PlanTier, PlanLimits, TenantFeatures } from "./types";
import { PLAN_DEFINITIONS } from "./billing";

// ============================================
// In-memory tenant store (backed by Convex in production)
// ============================================

const tenantStore = new Map<string, TenantConfig>();
const subdomainIndex = new Map<string, string>(); // subdomain -> tenantId

// ============================================
// Tenant CRUD
// ============================================

/**
 * Provision a new tenant for a user.
 * Sets up subdomain mapping and assigns plan limits.
 */
export function createTenant(
  userId: string,
  clerkId: string,
  subdomain: string,
  plan: PlanTier = "free",
): TenantConfig {
  // Validate subdomain format: lowercase alphanumeric + hyphens, 3-30 chars
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(subdomain)) {
    throw new Error(
      `Invalid subdomain "${subdomain}": must be 3-30 chars, lowercase alphanumeric and hyphens only`,
    );
  }

  // Check subdomain availability
  if (subdomainIndex.has(subdomain)) {
    throw new Error(`Subdomain "${subdomain}" is already taken`);
  }

  // Reserved subdomains
  const reserved = new Set([
    "www", "api", "app", "admin", "dashboard", "docs",
    "blog", "status", "mail", "help", "support",
  ]);
  if (reserved.has(subdomain)) {
    throw new Error(`Subdomain "${subdomain}" is reserved`);
  }

  const planDef = PLAN_DEFINITIONS[plan];
  const tenant: TenantConfig = {
    tenantId: userId,
    clerkId,
    subdomain,
    plan,
    limits: planDef.limits,
    features: planDef.features,
    createdAt: Date.now(),
  };

  tenantStore.set(userId, tenant);
  subdomainIndex.set(subdomain, userId);

  return tenant;
}

/**
 * Look up a tenant by subdomain.
 * Used by middleware to resolve `username.8gent.app` to a tenant.
 */
export function getTenantBySubdomain(subdomain: string): TenantConfig | null {
  const tenantId = subdomainIndex.get(subdomain);
  if (!tenantId) return null;
  return tenantStore.get(tenantId) ?? null;
}

/**
 * Get a tenant by their user ID.
 */
export function getTenantById(tenantId: string): TenantConfig | null {
  return tenantStore.get(tenantId) ?? null;
}

/**
 * List all tenants, optionally filtered by plan.
 */
export function listTenants(planFilter?: PlanTier): TenantConfig[] {
  const all = Array.from(tenantStore.values());
  if (planFilter) {
    return all.filter((t) => t.plan === planFilter);
  }
  return all;
}

/**
 * Update a tenant's plan. Recalculates limits and features.
 */
export function updateTenantPlan(tenantId: string, newPlan: PlanTier): TenantConfig {
  const tenant = tenantStore.get(tenantId);
  if (!tenant) {
    throw new Error(`Tenant "${tenantId}" not found`);
  }

  const planDef = PLAN_DEFINITIONS[newPlan];
  const updated: TenantConfig = {
    ...tenant,
    plan: newPlan,
    limits: planDef.limits,
    features: planDef.features,
  };

  tenantStore.set(tenantId, updated);
  return updated;
}

/**
 * Update a tenant's subdomain. Validates and re-indexes.
 */
export function updateTenantSubdomain(tenantId: string, newSubdomain: string): TenantConfig {
  const tenant = tenantStore.get(tenantId);
  if (!tenant) {
    throw new Error(`Tenant "${tenantId}" not found`);
  }

  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(newSubdomain)) {
    throw new Error(`Invalid subdomain "${newSubdomain}"`);
  }

  // Check if new subdomain is taken by someone else
  const existingOwner = subdomainIndex.get(newSubdomain);
  if (existingOwner && existingOwner !== tenantId) {
    throw new Error(`Subdomain "${newSubdomain}" is already taken`);
  }

  // Remove old mapping
  subdomainIndex.delete(tenant.subdomain);

  // Set new mapping
  const updated: TenantConfig = { ...tenant, subdomain: newSubdomain };
  tenantStore.set(tenantId, updated);
  subdomainIndex.set(newSubdomain, tenantId);

  return updated;
}

/**
 * Delete a tenant and remove subdomain mapping.
 */
export function deleteTenant(tenantId: string): boolean {
  const tenant = tenantStore.get(tenantId);
  if (!tenant) return false;

  subdomainIndex.delete(tenant.subdomain);
  tenantStore.delete(tenantId);
  return true;
}

// ============================================
// Usage Limit Enforcement
// ============================================

/**
 * Check if a tenant is within their usage limits for today.
 *
 * @param tenantId - The tenant to check
 * @param currentDailyTokens - Tokens consumed today (from Convex usage table)
 * @param currentActiveSessions - Currently active sessions (from Convex sessions table)
 * @returns Whether the tenant can continue and their current usage
 */
export function checkUsageLimits(
  tenantId: string,
  currentDailyTokens: number,
  currentActiveSessions: number,
): { within: boolean; tokenUsage: number; tokenLimit: number; sessionUsage: number; sessionLimit: number } {
  const tenant = tenantStore.get(tenantId);
  if (!tenant) {
    return {
      within: false,
      tokenUsage: currentDailyTokens,
      tokenLimit: 0,
      sessionUsage: currentActiveSessions,
      sessionLimit: 0,
    };
  }

  const tokenWithin =
    tenant.limits.tokensPerDay === -1 ||
    currentDailyTokens < tenant.limits.tokensPerDay;

  const sessionWithin =
    tenant.limits.maxConcurrentSessions === -1 ||
    currentActiveSessions < tenant.limits.maxConcurrentSessions;

  return {
    within: tokenWithin && sessionWithin,
    tokenUsage: currentDailyTokens,
    tokenLimit: tenant.limits.tokensPerDay,
    sessionUsage: currentActiveSessions,
    sessionLimit: tenant.limits.maxConcurrentSessions,
  };
}

/**
 * Check if a specific feature is enabled for a tenant.
 */
export function isFeatureEnabled(
  tenantId: string,
  feature: keyof TenantFeatures,
): boolean {
  const tenant = tenantStore.get(tenantId);
  if (!tenant) return false;
  return tenant.features[feature];
}

/**
 * Resolve a hostname to a tenant subdomain.
 * Extracts the subdomain from `username.8gent.app` or `username.localhost`.
 */
export function resolveSubdomain(hostname: string): string | null {
  // Production: username.8gent.app
  const prodMatch = hostname.match(/^([a-z0-9][a-z0-9-]+[a-z0-9])\.8gent\.app$/);
  if (prodMatch) return prodMatch[1];

  // Development: username.localhost
  const devMatch = hostname.match(/^([a-z0-9][a-z0-9-]+[a-z0-9])\.localhost/);
  if (devMatch) return devMatch[1];

  return null;
}
