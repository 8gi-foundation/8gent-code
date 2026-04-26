/**
 * @8gent/db — Conversation History Functions
 *
 * Convex queries and mutations for conversation history and session resume.
 * Stores message checkpoints for cross-device session continuity.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ============================================
// Queries
// ============================================

/**
 * Get recent conversations for a user, ordered by last activity.
 */
export const getRecent = query({
	args: {
		userId: v.id("users"),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { userId, limit }) => {
		const results = await ctx.db
			.query("conversations")
			.withIndex("by_userId_lastActiveAt", (q) => q.eq("userId", userId))
			.order("desc")
			.take(limit ?? 10);

		return results;
	},
});

/**
 * Get a specific conversation by ID.
 */
export const getById = query({
	args: { id: v.id("conversations") },
	handler: async (ctx, { id }) => {
		return await ctx.db.get(id);
	},
});

/**
 * Get a conversation by its local session ID.
 * Used for cross-device restore - fetch checkpoint data from a remote session.
 */
export const getBySessionId = query({
	args: { sessionId: v.string() },
	handler: async (ctx, { sessionId }) => {
		return await ctx.db
			.query("conversations")
			.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
			.unique();
	},
});

/**
 * Search conversations by title/summary text.
 */
export const search = query({
	args: {
		userId: v.id("users"),
		query: v.string(),
	},
	handler: async (ctx, { userId, query: searchQuery }) => {
		const all = await ctx.db
			.query("conversations")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();

		const lower = searchQuery.toLowerCase();
		return all
			.filter(
				(c) =>
					c.title.toLowerCase().includes(lower) ||
					c.summary?.toLowerCase().includes(lower),
			)
			.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
			.slice(0, 20);
	},
});

// ============================================
// Mutations
// ============================================

/**
 * Create or update a conversation record.
 * Uses sessionId for upsert logic.
 */
export const upsert = mutation({
	args: {
		userId: v.id("users"),
		sessionId: v.string(),
		title: v.string(),
		summary: v.optional(v.string()),
		messageCount: v.number(),
		model: v.string(),
		workingDirectory: v.string(),
		gitBranch: v.optional(v.string()),
		checkpointData: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { userId, sessionId, ...data } = args;
		const now = Date.now();

		const existing = await ctx.db
			.query("conversations")
			.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				...data,
				lastActiveAt: now,
			});
			return existing._id;
		}

		return await ctx.db.insert("conversations", {
			userId,
			sessionId,
			...data,
			startedAt: now,
			lastActiveAt: now,
		});
	},
});

/**
 * Update just the checkpoint data for a conversation.
 * Called periodically during active sessions.
 */
export const updateCheckpoint = mutation({
	args: {
		sessionId: v.string(),
		checkpointData: v.string(),
		messageCount: v.number(),
	},
	handler: async (ctx, { sessionId, checkpointData, messageCount }) => {
		const existing = await ctx.db
			.query("conversations")
			.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				checkpointData,
				messageCount,
				lastActiveAt: Date.now(),
			});
			return true;
		}
		return false;
	},
});
