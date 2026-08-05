// Run the workspace scan and drop the findings into a #cleanup Table channel with
// Rishi (8TO) + Samantha (8PO) seated, so James can triage unfinished branches and
// sessions in Table. The scan runs in trusted code (not the sandboxed agent).
//
// IMPORTANT: posts through the DAEMON WebSocket, never a second TableStore. The
// daemon is the single ledger writer; a second store racing it duplicates seq
// numbers and breaks the hash chain (learned the hard way - see repair-table-ledger).
import { runScan } from "./workspace-scan";

const WS = "ws://127.0.0.1:18789";
const OFFICERS = ["agent:8TO", "agent:8PO"];

function post(ws: WebSocket, content: string) {
	ws.send(JSON.stringify({ type: "message:post", id: crypto.randomUUID(), channelId: chanId, content }));
}
let chanId = "";

const scan = runScan();
const byRepo: Record<string, number> = {};
for (const b of scan.branches.items) byRepo[b.repo] = (byRepo[b.repo] || 0) + 1;
const topRepos = Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 12);

const overview = [
	`Workspace scan - ${scan.scannedAt.slice(0, 10)}`,
	`- ${scan.branches.total} unfinished branches (${scan.branches.stale30} stale >30 days) across ${Object.keys(byRepo).length} repos`,
	`- ${scan.sessions.total} unfinished Claude Code sessions (you spoke last, the agent never finished)`,
	``,
	`Top repos by unfinished branches:`,
	...topRepos.map(([r, c]) => `  ${String(c).padStart(4)}  ${r}`),
].join("\n");
const sessions = scan.sessions.items.length
	? ["Unfinished sessions (most recent first):",
		...scan.sessions.items.slice(0, 12).map((x) =>
			`  ${x.ageDays}d  ${x.project}${x.branch ? ` [${x.branch}]` : ""}  ${x.preview.slice(0, 60)}`)].join("\n")
	: "";
// No literal @handle here so it does not auto-trigger an officer - it is guidance.
const guide = "Rishi (8TO) and Samantha (8PO) are seated here. @-mention one to start - ask which repos' branches are safe to prune, and how to group the rest into project channels.";

const ws = new WebSocket(WS);
let step = 0;
ws.onopen = () => ws.send(JSON.stringify({ type: "channel:list", id: "l" }));
ws.onmessage = (e: any) => {
	const m = JSON.parse(e.data.toString());
	if (m.type === "channel:listed") {
		const c = m.channels.find((x: any) => x.name === "cleanup");
		if (c) { chanId = c.id; addMembersThenPost(ws); }
		else ws.send(JSON.stringify({ type: "channel:create", id: "c", name: "cleanup", visibility: "open", channelType: "stream", topic: "Unfinished branches + sessions. Rishi + Samantha help you triage." }));
	}
	if (m.type === "channel:created") { chanId = m.channel.id; addMembersThenPost(ws); }
	if (m.type === "channel:memberAdded" || m.type === "table:error") {
		// members are best-effort; proceed to posting once we've tried them all
	}
	if (m.type === "message:posted") {
		step++;
		if (step === 1 && sessions) post(ws, sessions);
		else if ((step === 1 && !sessions) || step === 2) post(ws, guide);
		else { console.log("posted findings to #cleanup"); ws.close(); process.exit(0); }
	}
};
ws.onerror = (e: any) => { console.error("ws error", e.message ?? e); process.exit(1); };

function addMembersThenPost(ws: WebSocket) {
	for (const oid of OFFICERS) {
		ws.send(JSON.stringify({ type: "channel:members", id: crypto.randomUUID(), channelId: chanId, op: "add", participantId: oid, role: "member" }));
	}
	post(ws, overview); // the daemon serializes these on one connection
}

setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
