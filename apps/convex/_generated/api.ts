/**
 * Stub for Convex auto-generated api types.
 *
 * The real file is produced by `bunx convex codegen` from the convex/
 * schema. We do not check that file in. This stub keeps `tsc --noEmit`
 * green so unrelated CI jobs do not cascade-fail.
 *
 * If you are running the dashboard against a live Convex deployment,
 * `convex codegen` will replace this file with strongly-typed API surfaces.
 */

// Permissive shape so `useQuery(api.x.y)` returns any, not unknown.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = { [k: string]: { [k: string]: any } };

export const api: AnyApi = new Proxy({}, {
  get: () => new Proxy({}, { get: () => (() => null) }),
}) as AnyApi;

export const internal: AnyApi = api;
