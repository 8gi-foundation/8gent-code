/**
 * @8gent/db — Governance admin functions (ported from steady-possum-557)
 *
 * Renamed from `admin.ts` in the governance repo to avoid collision with
 * the platform telemetry `admin.ts` already in this package.
 *
 * See docs/2026-05-10-convex-consolidation-plan.md.
 */

import { v } from "convex/values"
import { mutation } from "./_generated/server"

const submissionStatus = v.union(
  v.literal("Draft"),
  v.literal("In progress"),
  v.literal("Submitted"),
  v.literal("Published"),
  v.literal("Withdrawn"),
)

export const setSubmissionStatus = mutation({
  args: {
    slug: v.string(),
    status: submissionStatus,
    submitted_at: v.optional(v.union(v.string(), v.null())),
    submitted_via: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("submissions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
    if (!row) throw new Error(`Submission not found: ${args.slug}`)

    const patch: Record<string, unknown> = { status: args.status }
    if (args.submitted_at !== undefined) patch.submitted_at = args.submitted_at
    if (args.submitted_via !== undefined) patch.submitted_via = args.submitted_via

    await ctx.db.patch(row._id, patch)
    return { slug: args.slug, status: args.status }
  },
})
