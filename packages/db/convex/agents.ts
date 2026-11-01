import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const saveTranscript = mutation({
  args: {
    roomId: v.string(),
    agentId: v.string(),
    agentName: v.string(),
    messages: v.array(
      v.object({
        id: v.string(),
        timestamp: v.number(),
        speaker: v.string(),
        text: v.string(),
      })
    ),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    metadata: v.optional(
      v.object({
        userContext: v.optional(v.string()),
        agentVersion: v.optional(v.string()),
        modelUsed: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const transcriptId = await ctx.db.insert("agentTranscripts", {
      roomId: args.roomId,
      agentId: args.agentId,
      agentName: args.agentName,
      messages: args.messages,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      metadata: args.metadata,
    });
    return transcriptId;
  },
});

export const getTranscript = query({
  args: { transcriptId: v.id("agentTranscripts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.transcriptId);
  },
});

export const listTranscriptsByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentTranscripts")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
  },
});

export const listTranscriptsByAgent = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentTranscripts")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();
  },
});

export const saveSession = mutation({
  args: {
    roomId: v.string(),
    agentIds: v.array(v.string()),
    participantCount: v.number(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    transcriptIds: v.array(v.id("agentTranscripts")),
  },
  handler: async (ctx, args) => {
    const sessionId = await ctx.db.insert("agentSessions", {
      roomId: args.roomId,
      agentIds: args.agentIds,
      participantCount: args.participantCount,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      transcriptIds: args.transcriptIds,
    });
    return sessionId;
  },
});

export const updateAgentContext = mutation({
  args: {
    agentId: v.string(),
    userId: v.optional(v.string()),
    calendar: v.optional(
      v.array(
        v.object({
          title: v.string(),
          start: v.number(),
          end: v.number(),
        })
      )
    ),
    projects: v.optional(v.array(v.string())),
    memory: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agentContext")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        userId: args.userId,
        calendar: args.calendar,
        projects: args.projects,
        memory: args.memory,
        lastUpdated: Date.now(),
      });
      return existing._id;
    }

    const contextId = await ctx.db.insert("agentContext", {
      agentId: args.agentId,
      userId: args.userId,
      calendar: args.calendar,
      projects: args.projects,
      memory: args.memory,
      lastUpdated: Date.now(),
    });
    return contextId;
  },
});

export const getAgentContext = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentContext")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .first();
  },
});
