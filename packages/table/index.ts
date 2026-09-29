/**
 * @8gent/table - public surface.
 *
 * A sovereign human+agent workspace: named channels whose members are humans
 * and agents. Humans post; agents post only through the gated post_to_channel
 * tool after being @mentioned. Every mutation is appended to the signed,
 * hash-chained goal ledger. Messages live in a local bun:sqlite DB with an
 * FTS5 index. Local model only; daemon binds loopback. No bypassPermissions.
 */

export {
	type Channel,
	type ChannelType,
	type Member,
	type MemberRole,
	type Message,
	type ParticipantId,
	type SearchHit,
	type ThreadView,
	type TableErrorCode,
	type Visibility,
	TableError,
	TableAuthError,
	TableValidationError,
	TableConflictError,
	TableNotFoundError,
} from "./types.js";

export {
	TableStore,
	type TableStoreOptions,
	canonicalMessage,
	contentHash,
	defaultTableDbPath,
	openDefaultTableLedger,
} from "./store.js";

export {
	newChannelId,
	newMessageId,
	isChannelId,
	isMessageId,
} from "./ids.js";

export {
	type Identity,
	type KeyDir,
	defaultKeyDir,
	ensureIdentity,
	fileBaseFor,
	loadIdentity,
	mintIdentity,
	publicKeyOf,
	signMessage,
	verifyMessage,
} from "./identity.js";

export { scanMentions } from "./mentions.js";

export {
	type Officer,
	type OfficerProvider,
	OFFICERS,
	listOfficers,
	resolveOfficer,
} from "./officers.js";

export {
	CHANNEL_POST_ACTION,
	TABLE_AGENT_SCOPE,
	TABLE_AGENT_RESTRICTIONS,
	installTablePolicies,
	resolveMentionedAgents,
	tableSessionId,
} from "./wiring.js";

export {
	type AgentTool,
	type PostToChannelDeps,
	type PostToChannelInput,
	type PostToChannelResult,
	makePostToChannelTool,
} from "./tools/post-to-channel.js";

export {
	SPEAK_URL_RE,
	handleTableSpeakHttp,
	synthesizeMessageSpeech,
	voiceForAuthor,
	type SpeakFailureReason,
	type SpeakResult,
	type SynthesizeDeps,
} from "./message-speak.js";

export {
	MESSAGE_AUDIO_URL_RE,
	handleTableAudioHttp,
	messageAudioDir,
	messageAudioRoot,
	messageAudioUrl,
	prepareMessageAudioDir,
} from "./message-audio.js";
