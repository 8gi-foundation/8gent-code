/**
 * @8gent/install-runner — public surface.
 *
 * Used by `bin/8gent.ts` for the `8gent install <preset>` subcommand
 * (interactive install with full stdio inheritance). Complementary to
 * the silent auto-installer in apps/tui/src/lib/external-agent-runner.ts
 * that runs from inside /spawn — same recipes, different UX.
 */

export {
	formatInstallHeader,
	planInstallRun,
	runInstall,
} from "./install-runner.js";
export type {
	InstallPreset,
	InstallRunPlan,
	InstallRunResult,
	RunInstallOpts,
} from "./install-runner.js";

export {
	defaultAppsDir,
	disableApp,
	enableApp,
	getApp,
	InstallAppError,
	installApp,
	listApps,
	uninstallApp,
	updateApp,
} from "./src/app-installer.js";
export type {
	AppManifest,
	InstallAppOptions,
	InstalledApp,
} from "./src/app-installer.js";
