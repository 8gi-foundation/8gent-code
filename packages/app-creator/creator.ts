import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	APP_CAPABILITIES,
	type AppCapability,
	type AppManifest,
	validateManifest,
} from "./manifest.js";
import {
	renderEntryTemplate,
	renderReadmeStub,
	renderSkillTemplate,
	renderTestTemplate,
} from "./templates.js";

export interface CreateAppInput {
	name: string;
	description?: string;
	capabilities?: AppCapability[];
	publish?: "personal" | "publishable";
	version?: string;
	author?: string;
	tags?: string[];
	/** Where personal apps live. Defaults to ~/.8gent/apps. */
	appsRoot?: string;
	/** Refuse to write into a non-empty target unless true. */
	allowOverwrite?: boolean;
	/** Required for actual disk writes. Drafts skip persistence. */
	approved?: boolean;
}

export interface AppDraft {
	manifest: AppManifest;
	dir: string;
	files: Record<string, string>;
	errors: string[];
}

export interface CreateAppResult extends AppDraft {
	persisted: boolean;
	written: string[];
}

const DEFAULT_DESCRIPTION_PREFIX = "Personal mini-app";

export function defaultAppsRoot(): string {
	return join(homedir(), ".8gent", "apps");
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function buildManifest(input: CreateAppInput): {
	manifest?: AppManifest;
	errors: string[];
} {
	const slug = slugify(input.name);
	const description = (input.description?.trim() || `${DEFAULT_DESCRIPTION_PREFIX}: ${slug}`).slice(
		0,
		200,
	);
	const candidate: Record<string, unknown> = {
		name: slug,
		description,
		version: input.version ?? "0.1.0",
		entry: "index.ts",
		capabilities: input.capabilities ?? [],
		publish: input.publish ?? "personal",
	};
	if (input.author) candidate.author = input.author;
	if (input.tags?.length) candidate.tags = input.tags;
	const v = validateManifest(candidate);
	if (!v.ok) return { errors: v.errors };
	return { manifest: v.manifest, errors: [] };
}

export function draftApp(input: CreateAppInput): AppDraft {
	const root = input.appsRoot ?? defaultAppsRoot();
	const built = buildManifest(input);
	if (!built.manifest) {
		return {
			manifest: {} as AppManifest,
			dir: "",
			files: {},
			errors: built.errors,
		};
	}
	const m = built.manifest;
	const dir = join(root, m.name);
	const files: Record<string, string> = {
		"manifest.json": `${JSON.stringify(m, null, 2)}\n`,
		"index.ts": renderEntryTemplate(m),
		"SKILL.md": renderSkillTemplate(m),
		"README.md": renderReadmeStub(m),
		"tests/index.test.ts": renderTestTemplate(m),
	};
	return { manifest: m, dir, files, errors: [] };
}

export function createApp(input: CreateAppInput): CreateAppResult {
	const draft = draftApp(input);
	if (draft.errors.length > 0 || !draft.manifest.name) {
		return { ...draft, persisted: false, written: [] };
	}
	if (!input.approved) {
		return { ...draft, persisted: false, written: [] };
	}

	const dir = draft.dir;
	const targetExists = existsSync(dir);
	if (targetExists && !input.allowOverwrite) {
		return {
			...draft,
			persisted: false,
			written: [],
			errors: [
				`app directory already exists: ${dir} (pass allowOverwrite to replace, or pick a new name)`,
			],
		};
	}

	mkdirSync(join(dir, "tests"), { recursive: true });
	const written: string[] = [];
	for (const [rel, contents] of Object.entries(draft.files)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, contents);
		written.push(full);
	}
	return { ...draft, persisted: true, written };
}

function dirname(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? "." : p.slice(0, idx);
}

export function listCapabilities(): readonly AppCapability[] {
	return APP_CAPABILITIES;
}
