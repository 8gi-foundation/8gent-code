/**
 * @8gent/app-creator
 *
 * Mini-app authoring for personal 8gent vessels.
 *
 * - Scaffolds apps/<name>/{manifest.json,index.ts,SKILL.md,tests/}.
 * - Manifest validated with zod.
 * - Apps loaded by `runApp(name, input, ctx)` for the agent's tool loop.
 * - Personal apps live in ~/.8gent/apps and are NOT committed to the repo.
 *
 * The embedded SKILL.md teaches the agent the iteration loop:
 * describe -> generate -> test -> refine.
 */

export {
	APP_CAPABILITIES,
	type AppCapability,
	type AppManifest,
	AppManifestSchema,
	type ManifestValidation,
	parseManifestFile,
	validateManifest,
} from "./manifest.js";

export {
	type AppDraft,
	type CreateAppInput,
	type CreateAppResult,
	createApp,
	defaultAppsRoot,
	draftApp,
	listCapabilities,
} from "./creator.js";

export {
	type AppModule,
	type AppRunContext,
	type AppRunInput,
	type AppRunResult,
	type LoadedApp,
	findApp,
	listApps,
	runApp,
} from "./loader.js";
