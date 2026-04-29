import { z } from "zod";

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

export const APP_CAPABILITIES = [
	"read",
	"write",
	"bash",
	"web",
	"memory",
	"music",
	"vision",
	"agent",
] as const;

export type AppCapability = (typeof APP_CAPABILITIES)[number];

export const AppManifestSchema = z.object({
	name: z.string().regex(SLUG_RE, {
		message: "name must be lowercase kebab-case, 3-40 chars",
	}),
	description: z.string().min(8).max(200),
	version: z.string().regex(SEMVER_RE, { message: "version must be semver" }),
	entry: z.string().min(1).default("index.ts"),
	capabilities: z.array(z.enum(APP_CAPABILITIES)).default([]),
	publish: z.enum(["personal", "publishable"]).default("personal"),
	author: z.string().optional(),
	tags: z.array(z.string()).max(10).optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;

export interface ManifestValidation {
	ok: boolean;
	manifest?: AppManifest;
	errors: string[];
}

export function validateManifest(input: unknown): ManifestValidation {
	const parsed = AppManifestSchema.safeParse(input);
	if (parsed.success) return { ok: true, manifest: parsed.data, errors: [] };
	const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
	return { ok: false, errors };
}

export function parseManifestFile(text: string): ManifestValidation {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, errors: [`manifest.json is not valid JSON: ${msg}`] };
	}
	return validateManifest(raw);
}
