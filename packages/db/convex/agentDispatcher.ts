/**
 * Agent dispatcher via agent-mail bus.
 *
 * Allows control plane or other agents to request agent spawns asynchronously.
 * Messages flow through the agent-mail system for auditability + retry logic.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const requestAgentSpawn = mutation({
  args: {
    requestId: v.string(),
    agentId: v.string(),
    roomName: v.string(),
    requestedBy: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();

    // Create agent-mail message for the dispatcher
    // This message will be processed by the remote agent-mail bus
    const mailId = await ctx.db.insert("agent_mail", {
      source_id: timestamp,
      from_agent: args.requestedBy,
      to_agent: "8-dispatcher", // special agent that handles spawn requests
      subject: `spawn:${args.agentId}`,
      body: JSON.stringify({
        requestId: args.requestId,
        agentId: args.agentId,
        roomName: args.roomName,
        metadata: args.metadata,
      }),
      read: false,
      timestamp,
      delivered_to_local: false,
    });

    return {
      mailId,
      requestId: args.requestId,
      status: "queued",
      timestamp,
    };
  },
});

export const getSpawnRequest = query({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const mail = await ctx.db
      .query("agent_mail")
      .filter((q) => q.eq(q.field("subject"), `spawn:*`))
      .collect();

    // Find the matching request
    return mail.find(
      (m) =>
        JSON.parse(m.body)?.requestId === args.requestId ||
        JSON.parse(m.body)?.agentId === args.requestId
    );
  },
});

export const listPendingSpawns = query({
  args: { agentId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const mail = await ctx.db
      .query("agent_mail")
      .withIndex("by_to_agent", (q) => q.eq("to_agent", "8-dispatcher"))
      .collect();

    const pending = mail
      .filter((m) => !m.read && m.subject.startsWith("spawn:"))
      .map((m) => ({
        id: m._id,
        ...JSON.parse(m.body),
        timestamp: m.timestamp,
      }));

    if (args.agentId) {
      return pending.filter((p) => p.agentId === args.agentId);
    }

    return pending;
  },
});

export const markSpawnProcessed = mutation({
  args: { mailId: v.id("agent_mail") },
  handler: async (ctx, args) => {
    const mail = await ctx.db.get(args.mailId);
    if (!mail) throw new Error("Mail not found");

    await ctx.db.patch(args.mailId, { read: true });
    return { processed: true };
  },
});
