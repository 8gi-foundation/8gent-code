/**
 * 8gent Actuator Tools
 *
 * Write to the world, not just read it. Deploy code, publish releases,
 * send messages. All actuators respect dryRun mode by default.
 *
 * Categories:
 * - deploy: Vercel, Railway, Fly.io
 * - publish: npm, git tags, GitHub releases
 * - notify: Telegram, GitHub issues
 */

// Types
export type { ActuatorResult, ActuatorConfig } from "./types";
export { defaultConfig, ok, fail } from "./types";

// Deploy
export { deployToVercel, deployToRailway, deployToFly } from "./deploy";

// Publish
export { npmPublish, gitTagAndPush, createGitHubRelease } from "./publish";

// Notify
export { sendTelegram, postToGitHubIssue } from "./notify";
