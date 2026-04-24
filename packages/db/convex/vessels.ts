/**
 * @8gent/db — Vessel Registry (Lotus-Class Compute)
 *
 * Peer-discovery table for the Grove shared-compute mesh. Vessels register on
 * startup, heartbeat every 30s, and read the list to discover peers. Stale rows
 * (lastHeartbeat > 90s ago) are filtered out by readers; a cron could prune them
 * for cleanliness, but it's not required for correctness.
 *
 * Internal-only during the spike. External-peer GA gates on #1565, #1566, #1567,
 * #1569 landing first.
 */

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const STALE_MS = 90_000;

export const register = mutation({
  args: {
    vesselId: v.string(),
    name: v.string(),
    url: v.string(),
    ownerId: v.string(),
    capabilities: v.array(v.string()),
    model: v.string(),
    region: v.string(),
    startedAt: v.number(),
    activeSessions: v.number(),
    maxSessions: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("vessels")
      .withIndex("by_vesselId", (q) => q.eq("vesselId", args.vesselId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        lastHeartbeat: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("vessels", { ...args, lastHeartbeat: now });
  },
});

export const heartbeat = mutation({
  args: {
    vesselId: v.string(),
    activeSessions: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("vessels")
      .withIndex("by_vesselId", (q) => q.eq("vesselId", args.vesselId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      lastHeartbeat: Date.now(),
      activeSessions: args.activeSessions,
    });
    return row._id;
  },
});

export const unregister = mutation({
  args: { vesselId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("vessels")
      .withIndex("by_vesselId", (q) => q.eq("vesselId", args.vesselId))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_MS;
    const rows = await ctx.db.query("vessels").collect();
    return rows.filter((r) => r.lastHeartbeat >= cutoff);
  },
});
