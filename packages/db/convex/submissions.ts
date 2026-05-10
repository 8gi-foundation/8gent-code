import { query, mutation } from "./_generated/server"
import { v } from "convex/values"

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("submissions").withIndex("by_sort_order").collect()
    return rows.sort((a, b) => a.sort_order - b.sort_order)
  },
})

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("submissions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
  },
})

const submissionStatus = v.union(
  v.literal("Draft"),
  v.literal("In progress"),
  v.literal("Submitted"),
  v.literal("Published"),
  v.literal("Withdrawn")
)

export const upsert = mutation({
  args: {
    slug: v.string(),
    title: v.string(),
    subtitle: v.string(),
    href: v.union(v.string(), v.null()),
    jurisdiction: v.string(),
    committee: v.string(),
    committee_chair: v.union(v.string(), v.null()),
    inquiry_url: v.union(v.string(), v.null()),
    deadline: v.string(),
    deadline_iso: v.union(v.string(), v.null()),
    submitted_at: v.union(v.string(), v.null()),
    submitted_via: v.union(v.string(), v.null()),
    status: submissionStatus,
    source_file: v.union(v.string(), v.null()),
    pdf: v.union(v.string(), v.null()),
    docx: v.union(v.string(), v.null()),
    sort_order: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    const existing = await ctx.db
      .query("submissions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, args)
      return existing._id
    }
    return await ctx.db.insert("submissions", args)
  },
})

export const updateStatus = mutation({
  args: {
    slug: v.string(),
    status: submissionStatus,
    submitted_at: v.optional(v.string()),
    submitted_via: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    const row = await ctx.db
      .query("submissions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
    if (!row) throw new Error(`Submission not found: ${args.slug}`)

    const patch: Record<string, unknown> = { status: args.status }
    if (args.submitted_at !== undefined) patch.submitted_at = args.submitted_at
    if (args.submitted_via !== undefined) patch.submitted_via = args.submitted_via

    await ctx.db.patch(row._id, patch)
    return row._id
  },
})
