/**
 * @8gent/control-plane — Tenant Management
 *
 * CRUD operations for tenant configurations, subdomain mapping,
 * and usage limit enforcement.
 *
 * Supports two backends:
 * - ConvexTenantStore: persistent storage via Convex DB (production)
 * - InMemoryTenantStore: fallback for offline/local development
 *
 * Use `createTenantStore()` to get the appropriate backend.
 */

import type { TenantConfig, PlanTier, PlanLimits, TenantFeatures } from "./types";
import { PLAN_DEFINITIONS } from "./billing";

// ============================================
// TenantStore Interface
// ============================================

export interface TenantStore {
  create(
    userId: string,
    clerkId: string,
    subdomain: string,
    plan?: PlanTier,
  ): Promise<TenantConfig>;
  getById(tenantId: string): Promise<TenantConfig | null>;
  getBySubdomain(subdomain: string): Promise<TenantConfig | null>;
  list(planFilter?: PlanTier): Promise<TenantConfig[]>;
  updatePlan(tenantId: string, newPlan: PlanTier): Promise<TenantConfig>;
  updateSubdomain(tenantId: string, newSubdomain: string): Promise<TenantConfig>;
  delete(tenantId: string): Promise<boolean>;
}

// ============================================
// Subdomain Validation (shared)
// ============================================

const RESERVED_SUBDOMAINS = new Set([
  "www", "api", "app", "admin", "dashboard", "docs",
  "blog", "status", "mail", "help", "support",
]);

function validateSubdomain(subdomain: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(subdomain)) {
    throw new Error(
      `Invalid subdomain "${subdomain}": must be 3-30 chars, lowercase alphanumeric and hyphens only`,
    );
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    throw new Error(`Subdomain "${subdomain}" is reserved`);
  }
}

// ============================================
// Convex Tenant Store (production)
// ============================================

/**
 * ConvexTenantStore wraps Convex client calls to persist tenants.
 *
 * Expects a client object with `query` and `mutation` methods matching
 * the Convex client API (e.g., ConvexHttpClient or ConvexClient).
 */
export interface ConvexClient {
  query(fnRef: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(fnRef: string, args: Record<string, unknown>): Promise<unknown>;
}

interface ConvexTenantDoc {
  _id: string;
  tenantId: string;
  clerkId: string;
  subdomain: string;
  plan: PlanTier;
  limits: PlanLimits;
  features: TenantFeatures;
  createdAt: number;
}

function docToConfig(doc: ConvexTenantDoc): TenantConfig {
  return {
    tenantId: doc.tenantId,
    clerkId: doc.clerkId,
    subdomain: doc.subdomain,
    plan: doc.plan,
    limits: doc.limits,
    features: doc.features,
    createdAt: doc.createdAt,
  };
}

export class ConvexTenantStore implements TenantStore {
  constructor(private client: ConvexClient) {}

  async create(
    userId: string,
    clerkId: string,
    subdomain: string,
    plan: PlanTier = "free",
  ): Promise<TenantConfig> {
    validateSubdomain(subdomain);

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

    await this.client.mutation("tenants:create", {
      tenantId: tenant.tenantId,
      clerkId: tenant.clerkId,
      subdomain: tenant.subdomain,
      plan: tenant.plan,
      limits: tenant.limits,
      features: tenant.features,
      createdAt: tenant.createdAt,
    });

    return tenant;
  }

  async getById(tenantId: string): Promise<TenantConfig | null> {
    const doc = (await this.client.query("tenants:get", { tenantId })) as ConvexTenantDoc | null;
    return doc ? docToConfig(doc) : null;
  }

  async getBySubdomain(subdomain: string): Promise<TenantConfig | null> {
    const doc = (await this.client.query("tenants:getBySubdomain", { subdomain })) as ConvexTenantDoc | null;
    return doc ? docToConfig(doc) : null;
  }

  async list(planFilter?: PlanTier): Promise<TenantConfig[]> {
    const docs = (await this.client.query("tenants:listAll", {
      plan: planFilter,
    })) as ConvexTenantDoc[];
    return docs.map(docToConfig);
  }

  async updatePlan(tenantId: string, newPlan: PlanTier): Promise<TenantConfig> {
    const planDef = PLAN_DEFINITIONS[newPlan];

    await this.client.mutation("tenants:update", {
      tenantId,
      plan: newPlan,
      limits: planDef.limits,
      features: planDef.features,
    });

    const updated = await this.getById(tenantId);
    if (!updated) throw new Error(`Tenant "${tenantId}" not found after update`);
    return updated;
  }

  async updateSubdomain(tenantId: string, newSubdomain: string): Promise<TenantConfig> {
    validateSubdomain(newSubdomain);

    await this.client.mutation("tenants:update", {
      tenantId,
      subdomain: newSubdomain,
    });

    const updated = await this.getById(tenantId);
    if (!updated) throw new Error(`Tenant "${tenantId}" not found after update`);
    return updated;
  }

  async delete(tenantId: string): Promise<boolean> {
    return (await this.client.mutation("tenants:deleteTenant", { tenantId })) as boolean;
  }
}

// ============================================
// In-Memory Tenant Store (offline fallback)
// ============================================

export class InMemoryTenantStore implements TenantStore {
  private store = new Map<string, TenantConfig>();
  private subdomainIndex = new Map<string, string>();

  async create(
    userId: string,
    clerkId: string,
    subdomain: string,
    plan: PlanTier = "free",
  ): Promise<TenantConfig> {
    validateSubdomain(subdomain);

    if (this.subdomainIndex.has(subdomain)) {
      throw new Error(`Subdomain "${subdomain}" is already taken`);
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

    this.store.set(userId, tenant);
    this.subdomainIndex.set(subdomain, userId);
    return tenant;
  }

  async getById(tenantId: string): Promise<TenantConfig | null> {
    return this.store.get(tenantId) ?? null;
  }

  async getBySubdomain(subdomain: string): Promise<TenantConfig | null> {
    const tenantId = this.subdomainIndex.get(subdomain);
    if (!tenantId) return null;
    return this.store.get(tenantId) ?? null;
  }

  async list(planFilter?: PlanTier): Promise<TenantConfig[]> {
    const all = Array.from(this.store.values());
    if (planFilter) {
      return all.filter((t) => t.plan === planFilter);
    }
    return all;
  }

  async updatePlan(tenantId: string, newPlan: PlanTier): Promise<TenantConfig> {
    const tenant = this.store.get(tenantId);
    if (!tenant) throw new Error(`Tenant "${tenantId}" not found`);

    const planDef = PLAN_DEFINITIONS[newPlan];
    const updated: TenantConfig = {
      ...tenant,
      plan: newPlan,
      limits: planDef.limits,
      features: planDef.features,
    };

    this.store.set(tenantId, updated);
    return updated;
  }

  async updateSubdomain(tenantId: string, newSubdomain: string): Promise<TenantConfig> {
    const tenant = this.store.get(tenantId);
    if (!tenant) throw new Error(`Tenant "${tenantId}" not found`);

    validateSubdomain(newSubdomain);

    const existingOwner = this.subdomainIndex.get(newSubdomain);
    if (existingOwner && existingOwner !== tenantId) {
      throw new Error(`Subdomain "${newSubdomain}" is already taken`);
    }

    this.subdomainIndex.delete(tenant.subdomain);
    const updated: TenantConfig = { ...tenant, subdomain: newSubdomain };
    this.store.set(tenantId, updated);
    this.subdomainIndex.set(newSubdomain, tenantId);
    return updated;
  }

  async delete(tenantId: string): Promise<boolean> {
    const tenant = this.store.get(tenantId);
    if (!tenant) return false;

    this.subdomainIndex.delete(tenant.subdomain);
    this.store.delete(tenantId);
    return true;
  }
}

// ============================================
// Factory — picks backend based on environment
// ============================================

/**
 * Create the appropriate tenant store.
 *
 * - If a Convex client is provided, uses persistent Convex storage.
 * - Otherwise falls back to in-memory (offline mode).
 */
export function createTenantStore(convexClient?: ConvexClient): TenantStore {
  if (convexClient) {
    return new ConvexTenantStore(convexClient);
  }
  return new InMemoryTenantStore();
}

// ============================================
// Usage Limit Enforcement (stateless helpers)
// ============================================

/**
 * Check if a tenant is within their usage limits for today.
 *
 * @param tenant - The tenant config (fetched from store)
 * @param currentDailyTokens - Tokens consumed today (from Convex usage table)
 * @param currentActiveSessions - Currently active sessions (from Convex sessions table)
 * @returns Whether the tenant can continue and their current usage
 */
export function checkUsageLimits(
  tenant: TenantConfig | null,
  currentDailyTokens: number,
  currentActiveSessions: number,
): { within: boolean; tokenUsage: number; tokenLimit: number; sessionUsage: number; sessionLimit: number } {
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
  tenant: TenantConfig | null,
  feature: keyof TenantFeatures,
): boolean {
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
