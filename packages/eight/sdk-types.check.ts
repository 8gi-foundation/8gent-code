// Type-only drift check: the shipped declarations (sdk-public.d.ts) must accept
// what sdk.ts really exports. Run by tsc; nothing imports this file.
import type * as Public from "./sdk-public";
import * as Real from "./sdk";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const sessionMatches: Same<Public.SessionEvent, Real.SessionEvent> = true;
export const stateMatches: Same<Public.SessionState, Real.SessionState> = true;
export const optionsMatch: Same<Public.SessionOptions, Real.SessionOptions> = true;
export const listItemMatches: Same<Public.SessionListItem, Real.SessionListItem> = true;
export const publicSession: Public.Session = null as unknown as Real.Session;
export const factory: typeof Public.createSession = Real.createSession;
