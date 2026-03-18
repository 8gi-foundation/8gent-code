/**
 * @8gent/db — Tenant CRUD Functions
 *
 * Convex mutations and queries for multi-tenant management.
 * Tenants are provisioned when a user signs up and claims a subdomain.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================
// Shared validators
// ============================================

const planValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("team"),
);

const limitsValidator = v.object({
  tokensPerDay: v.number(),
  maxConcurrentSessions: v.number(),
  maxTeamMembers: v.number(),
  loraEnabled: v.boolean(),
});

const featuresValidator = v.object({
  customModels: v.boolean(),
  priorityQueue: v.boolean(),
  benchmarks: v.boolean(),
  apiAccess: v.boolean(),
});

// ============================================
// Queries
// ============================================

/**
 * Get a tenant by their tenant ID (user ID string).
 */
export const get = query({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
  },
});

/**
 * Get a tenant by their subdomain slug.
 * Used by middleware to resolve `username.8gent.app` to a tenant.
 */
export const getBySubdomain = query({
  args: { subdomain: v.string() },
  handler: async (ctx, { subdomain }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_subdomain", (q) => q.eq("subdomain", subdomain))
      .unique();
  },
});

/**
 * List all tenants, optionally filtered by plan tier.
 */
export const listAll = query({
  args: { plan: v.optional(planValidator) },
  handler: async (ctx, { plan }) => {
    if (plan) {
      return await ctx.db
        .query("tenants")
        .withIndex("by_plan", (q) => q.eq("plan", plan))
        .collect();
    }
    return await ctx.db.query("tenants").collect();
  },
});

// ============================================
// Mutations
// ============================================

/**
 * Create a new tenant record.
 * Returns the Convex document ID.
 */
export const create = mutation({
  args: {
    tenantId: v.string(),
    clerkId: v.string(),
    subdomain: v.string(),
    plan: planValidator,
    limits: limitsValidator,
    features: featuresValidator,
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    // Check subdomain uniqueness
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_subdomain", (q) => q.eq("subdomain", args.subdomain))
      .unique();

    if (existing) {
      throw new Error(`Subdomain "${args.subdomain}" is already taken`);
    }

    return await ctx.db.insert("tenants", {
      tenantId: args.tenantId,
      clerkId: args.clerkId,
      subdomain: args.subdomain,
      plan: args.plan,
      limits: args.limits,
      features: args.features,
      createdAt: args.createdAt,
    });
  },
});

/**
 * Update a tenant's plan, limits, and features.
 */
export const update = mutation({
  args: {
    tenantId: v.string(),
    plan: v.optional(planValidator),
    limits: v.optional(limitsValidator),
    features: v.optional(featuresValidator),
    subdomain: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, ...updates }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    if (!tenant) {
      throw new Error(`Tenant "${tenantId}" not found`);
    }

    // If updating subdomain, check uniqueness
    if (updates.subdomain) {
      const existing = await ctx.db
        .query("tenants")
        .withIndex("by_subdomain", (q) =>
          q.eq("subdomain", updates.subdomain!),
        )
        .unique();

      if (existing && existing._id !== tenant._id) {
        throw new Error(
          `Subdomain "${updates.subdomain}" is already taken`,
        );
      }
    }

    // Build patch object with only defined fields
    const patch: Record<string, unknown> = {};
    if (updates.plan !== undefined) patch.plan = updates.plan;
    if (updates.limits !== undefined) patch.limits = updates.limits;
    if (updates.features !== undefined) patch.features = updates.features;
    if (updates.subdomain !== undefined) patch.subdomain = updates.subdomain;

    await ctx.db.patch(tenant._id, patch);
    return tenant._id;
  },
});

/**
 * Delete a tenant by their tenant ID.
 */
export const deleteTenant = mutation({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    if (!tenant) return false;

    await ctx.db.delete(tenant._id);
    return true;
  },
});
