/**
 * post_to_channel - the Table agent's gated WRITE path (contract section 4).
 *
 * IMPORTANT (corrected): this is NOT a tool the model itself calls, and it is
 * not "the only tool a Table agent gets". During the @mention flow the model's
 * turn runs with the __table__ scope's gated toolset (an explicit read-only
 * allowlist in agent.ts; run_command, write, term_ orchestration, desktop
 * control and network are denied both by that scope and by ToolG8's __table__
 * block rules). The model produces
 * only reply TEXT. This factory is then applied by the daemon HARNESS
 * (table-routes.runMentionFlow) to perform the single write: it is ToolG8-gated
 * (channel_post) BEFORE any store write, with a defense-in-depth membership
 * re-check. Inbound channel text is only ever handled as DATA - never
 * interpolated into a command.
 */

import { ToolG8 } from "../../permissions/toolg8.js";
import type { PolicyContext } from "../../permissions/types.js";
import type { TableStore } from "../store.js";
import { CHANNEL_POST_ACTION, TABLE_AGENT_SCOPE } from "../wiring.js";

export interface PostToChannelInput {
	/** must be a channel the agent is a member of */
	channelId: string;
	/** the reply text */
	content: string;
	/** optional thread parent */
	replyTo?: string;
}

export interface PostToChannelResult {
	ok: boolean;
	messageId?: string;
	/** gate-deny or validation reason */
	error?: string;
}

/**
 * Minimal agent-tool shape. The daemon's agent registers this object into a
 * Table session's toolset. Kept local (a structural interface) so the Table
 * package has zero dependency on the agent runtime - the daemon adapts it to
 * whatever tool registry it uses.
 */
export interface AgentTool<I, O> {
	name: string;
	description: string;
	/** JSON-schema parameters for the model. */
	parameters: Record<string, unknown>;
	execute(input: I): Promise<O>;
}

export interface PostToChannelDeps {
	store: TableStore;
	/** the acting agent, "agent:<id>" */
	agentId: string;
	/** channel broadcast fn supplied by the gateway */
	broadcast: (channelId: string, frame: unknown) => void;
}

/**
 * Factory: binds the store + acting agentId at session-build time and returns
 * the gated tool.
 */
export function makePostToChannelTool(
	deps: PostToChannelDeps,
): AgentTool<PostToChannelInput, PostToChannelResult> {
	const { store, agentId, broadcast } = deps;

	return {
		name: "post_to_channel",
		description:
			"Post a message to a Table channel you are a member of. This is the ONLY way you may reply. " +
			"You were invoked because a member @mentioned you. Respond by calling this tool; never attempt any other action.",
		parameters: {
			type: "object",
			properties: {
				channelId: { type: "string", description: "Channel id you are a member of." },
				content: { type: "string", description: "Your reply text." },
				replyTo: { type: "string", description: "Optional parent message id to thread under." },
			},
			required: ["channelId", "content"],
		},
		async execute(input: PostToChannelInput): Promise<PostToChannelResult> {
			// 1. Gate every call BEFORE any store write. Table agents gate under
			//    the restricted scope id (like __spawned__); the real actor id
			//    rides in context for the audit trail.
			const context: PolicyContext = {
				channelId: input.channelId,
				actorId: agentId,
				targetTable: "messages",
				contentLength: input.content.length,
			};
			const gate = ToolG8.instance().gate(TABLE_AGENT_SCOPE, CHANNEL_POST_ACTION, context);
			if (!gate.allowed) {
				return { ok: false, error: gate.reason ?? "channel_post denied by policy" };
			}

			// 2. Membership re-check (defense in depth).
			if (!store.isMember(input.channelId, agentId)) {
				return { ok: false, error: `${agentId} is not a member of ${input.channelId}` };
			}

			// 3. Write via the same store path humans use (ledger append included).
			try {
				const msg = store.postMessage({
					channelId: input.channelId,
					authorId: agentId,
					content: input.content,
					replyTo: input.replyTo,
				});
				broadcast(input.channelId, {
					type: "message:appended",
					channelId: input.channelId,
					message: msg,
				});
				return { ok: true, messageId: msg.id };
			} catch (err) {
				return { ok: false, error: (err as Error).message ?? "post failed" };
			}
		},
	};
}
