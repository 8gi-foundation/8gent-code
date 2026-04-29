/**
 * 8gent App Marketplace - Manifest Schema
 *
 * Single source of truth for what a `manifest.json` inside a
 * `.8gent-app.tar.gz` archive must look like. Used by:
 *   - `8gent publish`             (build-time validation)
 *   - control plane               (registry submission)
 *   - the runtime installer       (post-extract validation)
 *
 * See docs/specs/APP-ARCHIVE-FORMAT.md for the full spec.
 */

import { z } from "zod";

export const CAPABILITY_TIERS = [
	"read",
	"write",
	"network",
	"process",
	"dangerous",
] as const;

export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KEYWORD_RE = /^[a-z0-9][a-z0-9-]*$/;

export const toolDeclarationSchema = z.object({
	name: z.string().min(1).max(64),
	description: z.string().max(280).optional(),
});

export const manifestSchema = z.object({
	manifestVersion: z.literal(1),
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(NAME_RE, "name must be lowercase letters, digits, or hyphens"),
	version: z.string().regex(SEMVER_RE, "version must be SemVer"),
	author: z.string().min(1).max(128),
	description: z.string().min(1).max(280),
	license: z.string().min(1).max(64),
	entry: z
		.string()
		.min(1)
		.refine((v) => !v.includes(".."), "entry must not traverse parent dirs")
		.refine((v) => !v.startsWith("/"), "entry must be relative"),
	capabilities: z.array(z.enum(CAPABILITY_TIERS)).default([]),
	homepage: z.string().url().optional(),
	repository: z.string().url().optional(),
	keywords: z
		.array(z.string().regex(KEYWORD_RE))
		.max(16)
		.optional(),
	engines: z
		.object({
			"8gent": z.string().min(1),
		})
		.optional(),
	tools: z.array(toolDeclarationSchema).optional(),
});

export type AppManifest = z.infer<typeof manifestSchema>;

export interface ManifestValidationResult {
	ok: boolean;
	manifest?: AppManifest;
	errors: string[];
}

/** Validate an unknown value against the manifest schema. Never throws. */
export function validateManifest(raw: unknown): ManifestValidationResult {
	const parsed = manifestSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, manifest: parsed.data, errors: [] };
	}
	const errors = parsed.error.issues.map((iss) => {
		const path = iss.path.length > 0 ? iss.path.join(".") : "<root>";
		return `${path}: ${iss.message}`;
	});
	return { ok: false, errors };
}

/**
 * Decide whether a manifest's capability set requires a manual
 * review override before the archive can be published.
 */
export function requiresDangerousOverride(manifest: AppManifest): boolean {
	return manifest.capabilities.includes("dangerous");
}
