/** The part of node:sqlite (Node 22.5+, Bun 1.4) the effect ledger uses; the repo's @types/node predates it. */
declare module "node:sqlite" {
	export class StatementSync {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	}
	export class DatabaseSync {
		constructor(path: string);
		exec(sql: string): void;
		prepare(sql: string): StatementSync;
		close(): void;
	}
}
