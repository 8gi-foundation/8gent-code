/** /quarantine handler. `add` is intentionally not exposed in the TUI. */
export interface QuarantineLike {
	list(status?: never): Array<{ id: string; status: string; name: string }>;
	quarantine(source: string): Promise<{ id: string; name: string }>;
	scan(id: string): Promise<{ verdict: string }>;
	release(id: string): Promise<void>;
	reject(id: string, reason: string): Promise<void>;
}

export async function runQuarantineCommand(qm: QuarantineLike, args: string[]): Promise<string> {
	const sub = args[0] || "list";
	const rest = args.slice(1);
	if (sub === "add") return "quarantine add is not available from the TUI yet.";
	if (sub === "list") {
		const entries = qm.list(rest[0] as never);
		return entries.length === 0
			? "Quarantine: empty."
			: entries.map((e) => `  ${e.id}  ${e.status}  ${e.name}`).join("\n");
	}
	if (sub === "scan" && rest[0]) return `Scan ${rest[0]}: ${(await qm.scan(rest[0])).verdict}`;
	if (sub === "release" && rest[0]) {
		await qm.release(rest[0]);
		return `Released ${rest[0]} to the toolshed.`;
	}
	if (sub === "reject" && rest[0]) {
		await qm.reject(rest[0], rest.slice(1).join(" ") || "rejected from TUI");
		return `Rejected ${rest[0]}.`;
	}
	return "Usage: /quarantine [scan <id>|list [status]|release <id>|reject <id> [reason]]";
}
