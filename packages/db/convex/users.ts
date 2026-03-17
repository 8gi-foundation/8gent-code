/**
 * @8gent/db — User CRUD Functions
 *
 * Convex mutations and queries for user management.
 * Users are created on first login and updated on subsequent logins.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================
// Queries
// ============================================

/**
 * Get a user by their Clerk ID.
 * Returns null if the user doesn't exist yet (first login).
 */
export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();
  },
});

/**
 * Get a user by their GitHub username.
 */
export const getByGithubUsername = query({
  args: { githubUsername: v.string() },
  handler: async (ctx, { githubUsername }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_githubUsername", (q) =>
        q.eq("githubUsername", githubUsername),
      )
      .unique();
  },
});

/**
 * Get the current authenticated user from the JWT identity.
 * Uses ctx.auth.getUserIdentity() to extract Clerk claims.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    return await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
  },
});

// ============================================
// Mutations
// ============================================

/**
 * Create or update a user on login.
 *
 * - First login: creates a new user record with GitHub profile data.
 * - Subsequent logins: updates lastActiveAt and profile fields.
 *
 * Returns the user ID.
 */
export const createOrUpdate = mutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    githubUsername: v.string(),
    displayName: v.string(),
    avatar: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if user already exists
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (existing) {
      // Update existing user
      await ctx.db.patch(existing._id, {
        email: args.email,
        githubUsername: args.githubUsername,
        displayName: args.displayName,
        avatar: args.avatar,
        lastActiveAt: Date.now(),
      });
      return existing._id;
    }

    // Create new user
    const userId = await ctx.db.insert("users", {
      clerkId: args.clerkId,
      email: args.email,
      githubUsername: args.githubUsername,
      displayName: args.displayName,
      avatar: args.avatar,
      plan: "free",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    // Create default preferences for new user
    await ctx.db.insert("preferences", {
      userId,
      defaultModel: "",
      defaultProvider: "ollama",
      theme: "default",
      loraStatus: "none",
      customPromptMutations: [],
      updatedAt: Date.now(),
    });

    return userId;
  },
});

/**
 * Update the lastActiveAt timestamp.
 * Called on each session start.
 */
export const updateLastActive = mutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();

    if (!user) return null;

    await ctx.db.patch(user._id, {
      lastActiveAt: Date.now(),
    });

    return user._id;
  },
});

/**
 * Update a user's subscription plan.
 */
export const updatePlan = mutation({
  args: {
    clerkId: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("team")),
  },
  handler: async (ctx, { clerkId, plan }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();

    if (!user) return null;

    await ctx.db.patch(user._id, { plan });
    return user._id;
  },
});

/**
 * Delete a user and all associated data.
 * Cascades to sessions, usage, and preferences.
 */
export const deleteUser = mutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique();

    if (!user) return false;

    // Delete all sessions
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    // Delete all usage records
    const usageRecords = await ctx.db
      .query("usage")
      .withIndex("by_userId_date", (q) => q.eq("userId", user._id))
      .collect();
    for (const record of usageRecords) {
      await ctx.db.delete(record._id);
    }

    // Delete preferences
    const prefs = await ctx.db
      .query("preferences")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (prefs) {
      await ctx.db.delete(prefs._id);
    }

    // Delete the user
    await ctx.db.delete(user._id);
    return true;
  },
});
