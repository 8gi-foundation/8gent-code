/**
 * channel:archive / channel:unarchive on the live daemon route path (issue #2889).
 *
 * The store tests prove archive is non-destructive and reversible. These prove
 * the daemon verbs that expose it are wired correctly and, critically, that the
 * new verbs inherit the F1 loopback guard rather than opening a fresh trust
 * surface. A mutation verb that skips the guard would be worse than having no
 * archive at all.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Ledger } from "../../goal/ledger.js";
import { TableStore } from "../../table/index.js";
import { type TableRouteDeps, type TableRouteState, handleTableFrame } from "../table-routes.js";

function freshStore(tmp: string): TableStore {
	const ledger = Ledger.open({
		runId: "table-archive",
		baseDir: path.join(tmp, "ledger"),
		key: randomBytes(32),
	});
	return new TableStore({ dbPath: ":memory:", ledger });
}

function harness(remoteAddress = "127.0.0.1") {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "table-arch-route-"));
	const store = freshStore(tmp);
	const state: TableRouteState = {
		subscribedChannels: new Set(),
		participantId: "human:local",
		remoteAddress,
	};
	const sent: Array<Record<string, unknown>> = [];
	const deps: TableRouteDeps = {
		store,
		pool: {} as TableRouteDeps["pool"],
		broadcast: () => {},
		sendRaw: (frame) => sent.push(frame as Record<string, unknown>),
		state,
	};
	const cleanup = () => {
		store.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	};
	return { store, deps, sent, cleanup };
}

describe("channel:archive routes", () => {
	it("archives, hides from the default list, and returns it with includeArchived", () => {
		const { store, deps, sent, cleanup } = harness();
		try {
			handleTableFrame(deps, {
				type: "channel:create",
				id: 1,
				name: "ws-8gi--dupe",
				channelType: "stream",
				visibility: "open",
			});
			const channelId = (sent[0].channel as { id: string }).id;

			handleTableFrame(deps, { type: "channel:archive", id: 2, channelId });
			const archived = sent.find((f) => f.type === "channel:archived");
			expect(archived).toBeDefined();
			expect(typeof (archived?.channel as { archivedAt?: number }).archivedAt).toBe("number");

			handleTableFrame(deps, { type: "channel:list", id: 3 });
			const listedDefault = sent.find((f) => f.type === "channel:listed" && f.id === 3);
			expect((listedDefault?.channels as unknown[]).length).toBe(0);

			handleTableFrame(deps, { type: "channel:list", id: 4, includeArchived: true });
			const listedAll = sent.find((f) => f.type === "channel:listed" && f.id === 4);
			expect((listedAll?.channels as unknown[]).length).toBe(1);

			// The record itself is untouched.
			expect(store.getChannel(channelId)).not.toBeNull();
		} finally {
			cleanup();
		}
	});

	it("unarchives back into the default listing", () => {
		const { deps, sent, cleanup } = harness();
		try {
			handleTableFrame(deps, {
				type: "channel:create",
				id: 1,
				name: "ws-8gi--back",
				channelType: "stream",
				visibility: "open",
			});
			const channelId = (sent[0].channel as { id: string }).id;

			handleTableFrame(deps, { type: "channel:archive", id: 2, channelId });
			handleTableFrame(deps, { type: "channel:unarchive", id: 3, channelId });
			const un = sent.find((f) => f.type === "channel:unarchived");
			expect(un).toBeDefined();
			expect((un?.channel as { archivedAt?: number }).archivedAt).toBeUndefined();

			handleTableFrame(deps, { type: "channel:list", id: 4 });
			const listed = sent.find((f) => f.type === "channel:listed" && f.id === 4);
			expect((listed?.channels as unknown[]).length).toBe(1);
		} finally {
			cleanup();
		}
	});

	// F1 must cover the new verbs. If this fails, the guard has a hole.
	it("rejects archive and unarchive from a non-loopback peer before touching the store", () => {
		const local = harness();
		let channelId = "";
		try {
			handleTableFrame(local.deps, {
				type: "channel:create",
				id: 1,
				name: "ws-8gi--guarded",
				channelType: "stream",
				visibility: "open",
			});
			channelId = (local.sent[0].channel as { id: string }).id;
		} finally {
			// keep the store alive for the remote attempt below
		}

		// Same store, but the frame arrives from off-box.
		local.deps.state.remoteAddress = "203.0.113.7";
		local.sent.length = 0;

		for (const type of ["channel:archive", "channel:unarchive"]) {
			handleTableFrame(local.deps, { type, id: 9, channelId });
		}
		expect(local.sent.length).toBe(2);
		for (const frame of local.sent) {
			expect(frame.type).toBe("table:error");
			expect(frame.code).toBe("TABLE_FORBIDDEN");
		}
		// Never archived.
		expect(local.store.getChannel(channelId)?.archivedAt).toBeUndefined();
		local.cleanup();
	});

	it("errors cleanly on an unknown channel id rather than silently succeeding", () => {
		const { deps, sent, cleanup } = harness();
		try {
			handleTableFrame(deps, { type: "channel:archive", id: 1, channelId: "chan_nope" });
			expect(sent[0].type).toBe("table:error");
			expect(sent[0].code).toBe("TABLE_NOT_FOUND");
		} finally {
			cleanup();
		}
	});
});
