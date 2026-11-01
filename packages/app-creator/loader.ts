import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAppsRoot } from "./creator.js";
import { type AppManifest, parseManifestFile } from "./manifest.js";

export interface LoadedApp {
	manifest: AppManifest;
	dir: string;
	entryPath: string;
}

export interface AppRunContext {
	log: (line: string) => void;
	capabilities: readonly string[];
}

export interface AppRunResult {
	ok: boolean;
	output: string;
	data?: unknown;
}

export interface AppRunInput {
	input: string;
	ctx: AppRunContext;
}

export interface AppModule {
	run: (args: AppRunInput) => Promise<AppRunResult> | AppRunResult;
	default?: { run: (args: AppRunInput) => Promise<AppRunResult> | AppRunResult };
}

export function listApps(appsRoot?: string): LoadedApp[] {
	const root = appsRoot ?? defaultAppsRoot();
	if (!existsSync(root)) return [];
	const out: LoadedApp[] = [];
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		if (!statSync(dir).isDirectory()) continue;
		const manifestPath = join(dir, "manifest.json");
		if (!existsSync(manifestPath)) continue;
		const text = readFileSync(manifestPath, "utf-8");
		const parsed = parseManifestFile(text);
		if (!parsed.ok || !parsed.manifest) continue;
		out.push({
			manifest: parsed.manifest,
			dir,
			entryPath: join(dir, parsed.manifest.entry),
		});
	}
	return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function findApp(name: string, appsRoot?: string): LoadedApp | null {
	const root = appsRoot ?? defaultAppsRoot();
	const dir = join(root, name);
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) return null;
	const parsed = parseManifestFile(readFileSync(manifestPath, "utf-8"));
	if (!parsed.ok || !parsed.manifest) return null;
	return {
		manifest: parsed.manifest,
		dir,
		entryPath: join(dir, parsed.manifest.entry),
	};
}

export async function runApp(
	name: string,
	input: string,
	ctx: AppRunContext,
	appsRoot?: string,
): Promise<AppRunResult> {
	const app = findApp(name, appsRoot);
	if (!app) {
		return { ok: false, output: `app not found: ${name}` };
	}
	if (!existsSync(app.entryPath)) {
		return { ok: false, output: `entry not found: ${app.entryPath}` };
	}
	const filtered = ctx.capabilities.filter((c) => app.manifest.capabilities.includes(c as never));
	const url = pathToFileURL(app.entryPath).href;
	const mod = (await import(url)) as AppModule;
	const runner = mod.run ?? mod.default?.run;
	if (typeof runner !== "function") {
		return { ok: false, output: `app ${name} has no run() export` };
	}
	const res = await runner({
		input,
		ctx: { log: ctx.log, capabilities: filtered },
	});
	return res;
}
