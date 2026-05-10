import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const list = query({
  args: {
    limit: v.optional(v.number()),
    toAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100
    if (args.toAgent) {
      const rows = await ctx.db
        .query("agent_mail")
        .withIndex("by_to_agent", (q) => q.eq("to_agent", args.toAgent!))
        .order("desc")
        .take(limit)
      return rows
    }
    const rows = await ctx.db
      .query("agent_mail")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit)
    return rows
  },
})

export const unreadCount = query({
  args: { toAgent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = args.toAgent
      ? await ctx.db
          .query("agent_mail")
          .withIndex("by_to_agent", (q) => q.eq("to_agent", args.toAgent!))
          .collect()
      : await ctx.db.query("agent_mail").collect()
    return rows.filter((r) => !r.read).length
  },
})

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("agent_mail").collect()
    const byAgent = new Map<string, { sent: number; received: number; unread: number }>()
    for (const row of rows) {
      const sender = byAgent.get(row.from_agent) ?? { sent: 0, received: 0, unread: 0 }
      sender.sent += 1
      byAgent.set(row.from_agent, sender)
      const receiver = byAgent.get(row.to_agent) ?? { sent: 0, received: 0, unread: 0 }
      receiver.received += 1
      if (!row.read) receiver.unread += 1
      byAgent.set(row.to_agent, receiver)
    }
    return {
      total: rows.length,
      unread: rows.filter((r) => !r.read).length,
      lastSync: rows.length ? Math.max(...rows.map((r) => r._creationTime)) : null,
      byAgent: Array.from(byAgent.entries())
        .map(([name, counts]) => ({ name, ...counts }))
        .sort((a, b) => b.received + b.sent - (a.received + a.sent)),
    }
  },
})

export const pushBatch = mutation({
  args: {
    token: v.string(),
    rows: v.array(
      v.object({
        source_id: v.number(),
        from_agent: v.string(),
        to_agent: v.string(),
        subject: v.string(),
        body: v.string(),
        read: v.boolean(),
        timestamp: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const expected = process.env.AGENT_MAIL_INGEST_TOKEN
    if (!expected || args.token !== expected) {
      throw new Error("unauthorised")
    }
    let inserted = 0
    let updated = 0
    for (const row of args.rows) {
      const existing = await ctx.db
        .query("agent_mail")
        .withIndex("by_source_id", (q) => q.eq("source_id", row.source_id))
        .unique()
      if (existing) {
        if (existing.read !== row.read) {
          await ctx.db.patch(existing._id, { read: row.read })
          updated += 1
        }
        continue
      }
      await ctx.db.insert("agent_mail", row)
      inserted += 1
    }
    return { inserted, updated }
  },
})

export const maxSourceId = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("agent_mail").collect()
    if (!rows.length) return 0
    return Math.max(...rows.map((r) => r.source_id))
  },
})

export const sendOutbound = mutation({
  args: {
    token: v.string(),
    from_agent: v.string(),
    to_agent: v.string(),
    subject: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const expected = process.env.AGENT_MAIL_INGEST_TOKEN
    if (!expected || args.token !== expected) {
      throw new Error("unauthorised")
    }
    const id = await ctx.db.insert("agent_mail", {
      source_id: 0,
      from_agent: args.from_agent,
      to_agent: args.to_agent,
      subject: args.subject,
      body: args.body,
      read: false,
      timestamp: Math.floor(Date.now() / 1000),
      delivered_to_local: false,
    })
    return { id }
  },
})

export const pendingOutbound = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const expected = process.env.AGENT_MAIL_INGEST_TOKEN
    if (!expected || args.token !== expected) {
      throw new Error("unauthorised")
    }
    const rows = await ctx.db
      .query("agent_mail")
      .withIndex("by_pending_outbound", (q) => q.eq("delivered_to_local", false))
      .collect()
    return rows.map((r) => ({
      _id: r._id,
      from_agent: r.from_agent,
      to_agent: r.to_agent,
      subject: r.subject,
      body: r.body,
      timestamp: r.timestamp,
    }))
  },
})

export const markDelivered = mutation({
  args: {
    token: v.string(),
    id: v.id("agent_mail"),
    source_id: v.number(),
  },
  handler: async (ctx, args) => {
    const expected = process.env.AGENT_MAIL_INGEST_TOKEN
    if (!expected || args.token !== expected) {
      throw new Error("unauthorised")
    }
    await ctx.db.patch(args.id, {
      delivered_to_local: true,
      source_id: args.source_id,
    })
    return { ok: true }
  },
})
