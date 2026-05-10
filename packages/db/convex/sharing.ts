import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"

const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"

function makeToken(len = 12): string {
  let out = ""
  for (let i = 0; i < len; i++) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)]
  }
  return out
}

export const createLink = mutation({
  args: {
    deckSlug: v.string(),
    label: v.string(),
    note: v.optional(v.string()),
    createdBy: v.string(),
    expiresAt: v.optional(v.number()),
    adminToken: v.string(),
  },
  handler: async (ctx, args) => {
    const expected = process.env.SHARE_ADMIN_TOKEN
    if (!expected || args.adminToken !== expected) {
      throw new Error("Unauthorized")
    }
    let token = makeToken()
    for (let i = 0; i < 5; i++) {
      const existing = await ctx.db
        .query("shareLinks")
        .withIndex("by_token", (q) => q.eq("token", token))
        .first()
      if (!existing) break
      token = makeToken()
    }
    const id = await ctx.db.insert("shareLinks", {
      token,
      deckSlug: args.deckSlug,
      label: args.label,
      note: args.note,
      createdAt: Date.now(),
      createdBy: args.createdBy,
      expiresAt: args.expiresAt,
      revoked: false,
    })
    return { id, token }
  },
})

export const getLink = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Doc<"shareLinks"> | null> => {
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first()
    if (!link) return null
    if (link.revoked) return null
    if (link.expiresAt && link.expiresAt < Date.now()) return null
    return link
  },
})

export const revokeLink = mutation({
  args: { token: v.string(), adminToken: v.string() },
  handler: async (ctx, args) => {
    const expected = process.env.SHARE_ADMIN_TOKEN
    if (!expected || args.adminToken !== expected) throw new Error("Unauthorized")
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first()
    if (!link) throw new Error("Not found")
    await ctx.db.patch(link._id, { revoked: true })
    return { ok: true }
  },
})

export const claimViewer = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    email: v.string(),
    userAgent: v.optional(v.string()),
    country: v.optional(v.string()),
    region: v.optional(v.string()),
    city: v.optional(v.string()),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first()
    if (!link) throw new Error("Invalid link")
    if (link.revoked) throw new Error("Link revoked")
    if (link.expiresAt && link.expiresAt < Date.now()) throw new Error("Link expired")

    const email = args.email.trim().toLowerCase()
    const existing = await ctx.db
      .query("shareViewers")
      .withIndex("by_token_email", (q) => q.eq("token", args.token).eq("email", email))
      .first()

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastSeenAt: now,
        userAgent: args.userAgent ?? existing.userAgent,
        country: args.country ?? existing.country,
        region: args.region ?? existing.region,
        city: args.city ?? existing.city,
        ip: args.ip ?? existing.ip,
      })
      return { viewerId: existing._id, deckSlug: link.deckSlug }
    }
    const viewerId = await ctx.db.insert("shareViewers", {
      token: args.token,
      name: args.name.trim(),
      email,
      firstSeenAt: now,
      lastSeenAt: now,
      userAgent: args.userAgent,
      country: args.country,
      region: args.region,
      city: args.city,
      ip: args.ip,
    })
    return { viewerId, deckSlug: link.deckSlug }
  },
})

export const recordEvent = mutation({
  args: {
    viewerId: v.id("shareViewers"),
    token: v.string(),
    type: v.union(
      v.literal("session_start"),
      v.literal("session_end"),
      v.literal("slide_view"),
      v.literal("media_play"),
      v.literal("media_pause"),
      v.literal("media_complete"),
    ),
    slideIndex: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    meta: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewer = await ctx.db.get(args.viewerId)
    if (!viewer || viewer.token !== args.token) throw new Error("Invalid viewer")
    await ctx.db.insert("shareEvents", {
      viewerId: args.viewerId,
      token: args.token,
      type: args.type,
      slideIndex: args.slideIndex,
      durationMs: args.durationMs,
      timestamp: Date.now(),
      meta: args.meta,
    })
    await ctx.db.patch(args.viewerId, { lastSeenAt: Date.now() })
    return { ok: true }
  },
})

export const listLinks = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    const expected = process.env.SHARE_ADMIN_TOKEN
    if (!expected || args.adminToken !== expected) throw new Error("Unauthorized")
    const links = await ctx.db.query("shareLinks").withIndex("by_created").order("desc").take(200)
    const result: Array<
      Doc<"shareLinks"> & {
        viewerCount: number
        eventCount: number
        lastActivityAt: number | null
      }
    > = []
    for (const link of links) {
      const viewers = await ctx.db
        .query("shareViewers")
        .withIndex("by_token", (q) => q.eq("token", link.token))
        .collect()
      const events = await ctx.db
        .query("shareEvents")
        .withIndex("by_token", (q) => q.eq("token", link.token))
        .collect()
      const lastActivityAt = events.length
        ? Math.max(...events.map((e) => e.timestamp))
        : null
      result.push({
        ...link,
        viewerCount: viewers.length,
        eventCount: events.length,
        lastActivityAt,
      })
    }
    return result
  },
})

type ViewerSummary = {
  viewer: Doc<"shareViewers">
  totalTimeMs: number
  slidesViewed: number[]
  furthestSlide: number
  mediaPlays: number
  events: Doc<"shareEvents">[]
}

export const linkAnalytics = query({
  args: { token: v.string(), adminToken: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    link: Doc<"shareLinks"> | null
    viewers: ViewerSummary[]
  }> => {
    const expected = process.env.SHARE_ADMIN_TOKEN
    if (!expected || args.adminToken !== expected) throw new Error("Unauthorized")
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first()
    if (!link) return { link: null, viewers: [] }

    const viewers = await ctx.db
      .query("shareViewers")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .collect()

    const summaries: ViewerSummary[] = []
    for (const viewer of viewers) {
      const events = await ctx.db
        .query("shareEvents")
        .withIndex("by_viewer", (q) => q.eq("viewerId", viewer._id))
        .collect()
      events.sort((a, b) => a.timestamp - b.timestamp)

      let totalTimeMs = 0
      const slideSeen = new Set<number>()
      let furthest = -1
      let mediaPlays = 0
      for (const e of events) {
        if (e.type === "slide_view" && e.durationMs) totalTimeMs += e.durationMs
        if (typeof e.slideIndex === "number") {
          slideSeen.add(e.slideIndex)
          if (e.slideIndex > furthest) furthest = e.slideIndex
        }
        if (e.type === "media_play") mediaPlays += 1
      }
      summaries.push({
        viewer,
        totalTimeMs,
        slidesViewed: Array.from(slideSeen).sort((a, b) => a - b),
        furthestSlide: furthest,
        mediaPlays,
        events,
      })
    }
    summaries.sort((a, b) => b.viewer.lastSeenAt - a.viewer.lastSeenAt)
    return { link, viewers: summaries }
  },
})
