/**
 * @8gent/db — Preference Sync Functions
 *
 * Convex mutations and queries for user preferences.
 * Preferences sync across machines — local config takes precedence on conflicts.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================
// Queries
// ============================================

/**
 * Get preferences for a user.
 * Returns null if no preferences exist (user should use defaults).
 */
export const get = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
  },
});

/**
 * Get preferences for the currently authenticated user.
 * Uses Clerk identity from the auth context.
 */
export const getCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Find user by Clerk ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) return null;

    return await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
  },
});

// ============================================
// Mutations
// ============================================

/**
 * Set preferences (full replace).
 * Creates a record if one doesn't exist, otherwise replaces all fields.
 */
export const set = mutation({
  args: {
    userId: v.id("users"),
    defaultModel: v.string(),
    defaultProvider: v.string(),
    theme: v.string(),
    loraStatus: v.union(
      v.literal("none"),
      v.literal("training"),
      v.literal("ready"),
    ),
    loraVersion: v.optional(v.string()),
    customPromptMutations: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, ...prefs } = args;

    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...prefs,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("preferences", {
      userId,
      ...prefs,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Merge preferences (partial update).
 * Only updates the fields that are provided, leaving others unchanged.
 * Creates a record with defaults if one doesn't exist.
 */
export const merge = mutation({
  args: {
    userId: v.id("users"),
    defaultModel: v.optional(v.string()),
    defaultProvider: v.optional(v.string()),
    theme: v.optional(v.string()),
    loraStatus: v.optional(
      v.union(
        v.literal("none"),
        v.literal("training"),
        v.literal("ready"),
      ),
    ),
    loraVersion: v.optional(v.string()),
    customPromptMutations: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { userId, ...updates } = args;

    // Remove undefined values
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    // Create with defaults + provided values
    return await ctx.db.insert("preferences", {
      userId,
      defaultModel: "",
      defaultProvider: "ollama",
      theme: "default",
      loraStatus: "none" as const,
      customPromptMutations: [],
      ...patch,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Delete preferences for a user.
 * Used during account deletion cascade.
 */
export const remove = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return true;
    }
    return false;
  },
});
