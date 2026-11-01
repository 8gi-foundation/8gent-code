/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agentDispatcher from "../agentDispatcher.js";
import type * as agentMail from "../agentMail.js";
import type * as agents from "../agents.js";
import type * as conversations from "../conversations.js";
import type * as governanceAdmin from "../governanceAdmin.js";
import type * as preferences from "../preferences.js";
import type * as seed from "../seed.js";
import type * as sessions from "../sessions.js";
import type * as sharing from "../sharing.js";
import type * as submissions from "../submissions.js";
import type * as tenants from "../tenants.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";
import type * as vessels from "../vessels.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agentDispatcher: typeof agentDispatcher;
  agentMail: typeof agentMail;
  agents: typeof agents;
  conversations: typeof conversations;
  governanceAdmin: typeof governanceAdmin;
  preferences: typeof preferences;
  seed: typeof seed;
  sessions: typeof sessions;
  sharing: typeof sharing;
  submissions: typeof submissions;
  tenants: typeof tenants;
  usage: typeof usage;
  users: typeof users;
  vessels: typeof vessels;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
