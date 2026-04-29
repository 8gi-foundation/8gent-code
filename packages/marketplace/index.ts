/**
 * 8gent App Marketplace - Public API
 *
 * Spec: docs/specs/APP-ARCHIVE-FORMAT.md
 */

export {
	type AppManifest,
	type CapabilityTier,
	CAPABILITY_TIERS,
	manifestSchema,
	requiresDangerousOverride,
	toolDeclarationSchema,
	validateManifest,
	type ManifestValidationResult,
} from "./manifest";

export {
	buildIntegrity,
	computeRootHash,
	hashBuffer,
	hashFile,
	INTEGRITY_FILENAME,
	type IntegrityFile,
	type IntegrityVerifyResult,
	listFiles,
	verifyIntegrity,
	writeIntegrity,
} from "./integrity";

export {
	getDefaultPatterns,
	isAllowedArchiveUrl,
	type AllowlistOptions,
} from "./url-allowlist";

export {
	ARCHIVE_SUFFIX,
	auditArchiveEntries,
	buildArchive,
	type BuildArchiveOptions,
	type EntryAuditResult,
	extractArchive,
	stageAppDirectory,
	type StageOptions,
} from "./archive";

export {
	auditCapabilities,
	type CapabilityAuditOptions,
	type CheckResult,
	checkSize,
	DEFAULT_MAX_BYTES,
	dirSize,
	lintSource,
	type SizeCheckOptions,
} from "./checks";

export {
	type PublishExitCode,
	type PublishOptions,
	type PublishResult,
	runPublish,
} from "./publish";
