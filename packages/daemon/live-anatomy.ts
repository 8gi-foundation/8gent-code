/**
 * Live anatomy (#4190): a localhost page that draws the running session as a
 * Mermaid graph, rebuilt from the daemon's own bus events.
 *
 *   bus events  ->  buildLiveGraph (pure, deterministic)  ->  /live/ws  ->  page
 *
 * Nodes are the session, the files it touched (grouped by folder), the shell
 * commands it ran and any other tool it called. Edges are the tool calls.
 * Each node carries the state of its latest call: running (green, pulsing),
 * paused (amber, waiting on an approval), failed (red) or done (grey).
 *
 * No model is in this path. The same events always give the same text, so a
 * test can pin it and a recording can be replayed.
 *
 * The page never sees raw events: it gets the Mermaid text and a node table
 * (labels, state, last diff or output). Approval request ids and chat ids
 * stay in the daemon.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isErrorToolResult } from "../eight/honesty";
import { scrub } from "../eight/secret-scanner";
import type { EventBus, EventName } from "./events";
import { SHAREABLE_CHANNELS } from "./shared-sessions";

export interface LiveEvent {
	event: string;
	payload: Record<string, unknown>;
}

export type LiveState = "running" | "paused" | "failed" | "done";
export type LiveKind = "session" | "file" | "command" | "tool";

export interface LiveNode {
	id: string;
	kind: LiveKind;
	label: string;
	state: LiveState;
	calls: number;
	lastTool?: string;
	/** Files: the last change as +/- lines. */
	diff?: string;
	/** Commands and tools: the last output preview. */
	output?: string;
	folder?: string;
}

export interface LiveGraph {
	mermaid: string;
	nodes: LiveNode[];
}

const LABEL_MAX = 60;
const DETAIL_MAX = 4000;
const DIFF_LINES_MAX = 200;
const SHELL_TOOLS = new Set(["run_command", "powershell", "bash", "shell"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Mermaid-safe quoted label text. */
function esc(text: string, max = LABEL_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const cut = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
	return cut
		.replace(/#/g, "#35;")
		.replace(/"/g, "#quot;")
		.replace(/</g, "#lt;")
		.replace(/>/g, "#gt;");
}

function clip(text: string): string {
	return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}\n...` : text;
}

function prefixed(text: string, sign: string): string[] {
	return text
		.split("\n")
		.slice(0, DIFF_LINES_MAX)
		.map((l) => `${sign} ${l}`);
}

/** The diff a file tool's input describes, or undefined for a read. */
function diffOf(tool: string, input: Record<string, unknown>): string | undefined {
	const oldText = str(input.oldText) ?? str(input.old_string);
	const newText = str(input.newText) ?? str(input.new_string);
	if (oldText !== undefined || newText !== undefined) {
		return clip([...prefixed(oldText ?? "", "-"), ...prefixed(newText ?? "", "+")].join("\n"));
	}
	const content = str(input.content);
	if (content !== undefined && /write|create/.test(tool))
		return clip(prefixed(content, "+").join("\n"));
	return undefined;
}

function folderOf(path: string): string {
	const i = path.replace(/\/+$/, "").lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : ".";
}

interface Target {
	key: string;
	kind: Exclude<LiveKind, "session">;
	label: string;
	path?: string;
}

/** Which node a tool call lands on. */
function targetOf(tool: string, input: Record<string, unknown>): Target {
	const command = str(input.command) ?? str(input.cmd);
	if (SHELL_TOOLS.has(tool) && command) {
		return { key: `c:${command.trim()}`, kind: "command", label: `$ ${command.trim()}` };
	}
	const path = str(input.path) ?? str(input.file_path) ?? str(input.filePath) ?? str(input.file);
	if (path) return { key: `f:${path}`, kind: "file", label: path, path };
	return { key: `t:${tool}`, kind: "tool", label: tool };
}

interface Call {
	session: string;
	target: string;
	tool: string;
	callId?: string;
}

/**
 * A failed call: success false, the honesty ledger's error markers, a non-zero
 * shell exit or a missing file. The executor reports most failures as text with
 * success true, so the flag alone would paint a failing command green.
 */
function failedResult(payload: Record<string, unknown>): boolean {
	if (payload.success === false) return true;
	const out = typeof payload.output === "string" ? payload.output.trimStart() : "";
	return isErrorToolResult(out) || /^(exit code [1-9]\d*\b|file not found\b|failed\b)/i.test(out);
}

/**
 * Fold bus events into a graph. Pure: no clock, no randomness, no I/O. Ids
 * and order come from first appearance in `events`.
 */
export function buildLiveGraph(events: readonly LiveEvent[]): LiveGraph {
	const nodes = new Map<string, LiveNode>();
	const order: string[] = [];
	const counters = { s: 0, f: 0, c: 0, t: 0 };
	const sessionNode = new Map<string, string>(); // sessionId -> node key
	const sessionErrorAt = new Map<string, number>();
	const sessionStartAt = new Map<string, number>();
	const sessionEnded = new Set<string>();
	const edges = new Map<string, { from: string; to: string; tool: string; n: number }>();
	const open: Call[] = []; // started, no result yet
	const paused = new Map<string, string>(); // requestId -> node key
	const pausedBySession = new Map<string, Set<string>>();

	const node = (key: string, make: () => Omit<LiveNode, "id" | "state" | "calls">): LiveNode => {
		let n = nodes.get(key);
		if (!n) {
			const base = make();
			const prefix =
				base.kind === "session"
					? "s"
					: base.kind === "file"
						? "f"
						: base.kind === "command"
							? "c"
							: "t";
			counters[prefix as keyof typeof counters] += 1;
			n = {
				id: `${prefix}${counters[prefix as keyof typeof counters]}`,
				state: "done",
				calls: 0,
				...base,
			};
			nodes.set(key, n);
			order.push(key);
		}
		return n;
	};

	const ensureSession = (sessionId: string, channel?: string): string => {
		const key = `s:${sessionId}`;
		const label = `session ${sessionId.slice(0, 8)}${channel ? ` - ${channel}` : ""}`;
		const n = node(key, () => ({ kind: "session", label }));
		if (channel && !n.label.includes(" - ")) n.label = label;
		sessionNode.set(sessionId, key);
		return key;
	};

	const targetNode = (tool: string, input: Record<string, unknown>): [LiveNode, string] => {
		const t = targetOf(tool, input);
		const n = node(t.key, () => ({
			kind: t.kind,
			label: t.label,
			...(t.path ? { folder: folderOf(t.path) } : {}),
		}));
		return [n, t.key];
	};

	events.forEach((ev, i) => {
		const p = obj(ev.payload);
		const sessionId = str(p.sessionId);
		if (!sessionId) return;
		switch (ev.event) {
			case "session:start":
				ensureSession(sessionId, str(p.channel));
				sessionStartAt.set(sessionId, i);
				sessionEnded.delete(sessionId);
				return;
			case "session:end":
				ensureSession(sessionId);
				sessionEnded.add(sessionId);
				return;
			case "agent:error":
				ensureSession(sessionId);
				sessionErrorAt.set(sessionId, i);
				return;
			case "tool:start": {
				const tool = str(p.tool) ?? "tool";
				const input = obj(p.input);
				const s = ensureSession(sessionId);
				const [n, k] = targetNode(tool, input);
				n.calls += 1;
				n.lastTool = tool;
				n.state = "running";
				const d = n.kind === "file" ? diffOf(tool, input) : undefined;
				if (d !== undefined) n.diff = d;
				const ek = `${s}|${k}|${tool}`;
				const e = edges.get(ek);
				if (e) e.n += 1;
				else edges.set(ek, { from: s, to: k, tool, n: 1 });
				open.push({ session: sessionId, target: k, tool, callId: str(p.toolCallId) });
				return;
			}
			case "tool:result": {
				const tool = str(p.tool) ?? "tool";
				const callId = str(p.toolCallId);
				let idx = callId ? open.findIndex((c) => c.callId === callId) : -1;
				if (idx < 0) idx = open.findIndex((c) => c.session === sessionId && c.tool === tool);
				if (idx < 0) return;
				const [call] = open.splice(idx, 1);
				const n = nodes.get(call.target);
				if (!n) return;
				n.state = failedResult(p) ? "failed" : "done";
				const out =
					typeof p.output === "string"
						? p.output
						: p.output === undefined
							? ""
							: JSON.stringify(p.output);
				if (n.kind !== "file" || n.state === "failed") n.output = clip(out);
				pausedBySession.get(sessionId)?.delete(call.target);
				return;
			}
			case "approval:required": {
				const tool = str(p.tool) ?? "tool";
				const input = obj(p.input);
				ensureSession(sessionId);
				const [n, k] = targetNode(tool, input);
				n.state = "paused";
				n.lastTool = tool;
				const rid = str(p.requestId);
				if (rid) paused.set(rid, k);
				const set = pausedBySession.get(sessionId) ?? new Set<string>();
				set.add(k);
				pausedBySession.set(sessionId, set);
				return;
			}
			case "approval:closed": {
				const rid = str(p.requestId);
				const k = rid ? paused.get(rid) : undefined;
				if (!k) return;
				paused.delete(rid as string);
				pausedBySession.get(sessionId)?.delete(k);
				const n = nodes.get(k);
				if (n) {
					n.state = "failed";
					n.output = `approval ${str(p.outcome) ?? "closed"}`;
				}
				return;
			}
		}
	});

	// A session's own state: a paused child, then a call in flight, then an
	// error since it started. An idle session is done (grey), never green.
	for (const [sessionId, key] of sessionNode) {
		const s = nodes.get(key) as LiveNode;
		const children = [...edges.values()]
			.filter((e) => e.from === key)
			.map((e) => nodes.get(e.to) as LiveNode);
		const err = sessionErrorAt.get(sessionId);
		if (children.some((c) => c.state === "paused")) s.state = "paused";
		else if (open.some((c) => c.session === sessionId) && !sessionEnded.has(sessionId))
			s.state = "running";
		else if (err !== undefined && err >= (sessionStartAt.get(sessionId) ?? -1)) s.state = "failed";
		else s.state = "done";
		s.calls = children.reduce((a, c) => a + c.calls, 0);
	}

	const list = order.map((k) => nodes.get(k) as LiveNode);
	return { mermaid: toMermaid(list, [...edges.values()], nodes), nodes: list };
}

const CLASS_DEFS = [
	"classDef running fill:#052e16,stroke:#22c55e,stroke-width:3px,color:#dcfce7",
	"classDef paused fill:#451a03,stroke:#f59e0b,stroke-width:3px,color:#fef3c7",
	"classDef failed fill:#450a0a,stroke:#ef4444,stroke-width:3px,color:#fee2e2",
	"classDef done fill:#111827,stroke:#6b7280,stroke-width:1px,color:#e5e7eb",
];

function shape(n: LiveNode): string {
	const label = `"${esc(n.label)}"`;
	switch (n.kind) {
		case "session":
			return `${n.id}([${label}])`;
		case "command":
			return `${n.id}[/${label}/]`;
		case "tool":
			return `${n.id}{{${label}}}`;
		default:
			return `${n.id}[${label}]`;
	}
}

function toMermaid(
	list: LiveNode[],
	edges: { from: string; to: string; tool: string; n: number }[],
	byKey: Map<string, LiveNode>,
): string {
	const lines = ["flowchart LR"];
	if (list.length === 0) {
		lines.push(`  idle(["no session events yet"])`, "  class idle done");
		return [...lines, ...CLASS_DEFS.map((c) => `  ${c}`)].join("\n");
	}
	const folders: string[] = [];
	for (const n of list) {
		if (n.kind === "file" && n.folder !== undefined && !folders.includes(n.folder))
			folders.push(n.folder);
	}
	for (const n of list) if (n.kind !== "file") lines.push(`  ${shape(n)}`);
	folders.forEach((folder, i) => {
		lines.push(`  subgraph d${i + 1}["${esc(folder)}"]`);
		for (const n of list)
			if (n.kind === "file" && n.folder === folder) lines.push(`    ${shape(n)}`);
		lines.push("  end");
	});
	for (const e of edges) {
		const from = byKey.get(e.from) as LiveNode;
		const to = byKey.get(e.to) as LiveNode;
		const label = e.n > 1 ? `${e.tool} x${e.n}` : e.tool;
		lines.push(`  ${from.id} -->|"${esc(label)}"| ${to.id}`);
	}
	for (const state of ["running", "paused", "failed", "done"] as const) {
		const ids = list.filter((n) => n.state === state).map((n) => n.id);
		if (ids.length) lines.push(`  class ${ids.join(",")} ${state}`);
	}
	return [...lines, ...CLASS_DEFS.map((c) => `  ${c}`)].join("\n");
}

/** JSON in, Mermaid out. */
export function sessionToMermaid(events: readonly LiveEvent[]): string {
	return buildLiveGraph(events).mermaid;
}

// ---------------------------------------------------------------------------
// Daemon side: a bounded event log, the /live page and the /live/ws feed.
// ---------------------------------------------------------------------------

const LIVE_EVENTS: EventName[] = [
	"session:start",
	"session:end",
	"tool:start",
	"tool:result",
	"agent:error",
	"approval:required",
	"approval:closed",
];
const MAX_EVENTS = 2000;

interface LiveSocket {
	send(data: string): unknown;
}
interface LiveClient {
	authed: boolean;
	session?: string;
}

const log: LiveEvent[] = [];
/** Channel of every session seen starting, so private ones stay out (8SO, 5844). */
const channels = new Map<string, string>();
const MAX_SESSIONS = 1000;
const liveClients = new Map<LiveSocket, LiveClient>();
let installedOn: EventBus | null = null;
let authToken: string | null = null;

function graphFor(session?: string): LiveGraph {
	const events = session ? log.filter((e) => e.payload.sessionId === session) : log;
	return buildLiveGraph(events);
}

function push(ws: LiveSocket, c: LiveClient): void {
	if (!c.authed) return;
	try {
		ws.send(JSON.stringify({ type: "live:graph", ...graphFor(c.session) }));
	} catch {
		liveClients.delete(ws);
	}
}

/** Subscribe the live log to the bus. Once per bus. */
export function installLiveAnatomy(bus: EventBus, token: string | null): void {
	authToken = token;
	if (installedOn === bus) return;
	installedOn = bus;
	for (const event of LIVE_EVENTS) {
		bus.on(event, (payload) => {
			const entry = admit(event, payload as Record<string, unknown>);
			if (!entry) return;
			log.push(entry);
			if (log.length > MAX_EVENTS) log.splice(0, log.length - MAX_EVENTS);
			for (const [ws, c] of liveClients) push(ws, c);
		});
	}
}

/** Every string in a payload through the daemon's secret scrubber (env keys, bearer tokens, keys), clipped to DETAIL_MAX. */
function scrubDeep(v: unknown, depth = 0): unknown {
	// Scrubbed, then clipped: a few multi-MB writes must not grow the log to hundreds of MB.
	if (typeof v === "string") return clip(scrub(v).scrubbed);
	if (depth > 6 || v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) out[k] = scrubDeep(x, depth + 1);
	return out;
}

/**
 * What the live log may keep (8SO, message 5844): only sessions on a shareable
 * channel (tui, os, app, api, browser), so telegram, table, delegation,
 * computer and classroom buffers never reach the page; a session whose start
 * was not seen is kept out too. Every string is scrubbed before it is stored.
 */
export function admit(event: string, payload: Record<string, unknown>): LiveEvent | null {
	const sessionId = str(payload.sessionId);
	if (!sessionId) return null;
	if (event === "session:start") {
		channels.set(sessionId, str(payload.channel) ?? "");
		if (channels.size > MAX_SESSIONS) channels.delete(channels.keys().next().value as string);
	}
	if (!SHAREABLE_CHANNELS.has(channels.get(sessionId) ?? "")) return null;
	return { event, payload: scrubDeep(payload) as Record<string, unknown> };
}

/** For tests: forget everything recorded. */
export function _resetLiveLogForTest(): void {
	log.length = 0;
	channels.clear();
	liveClients.clear();
}

function tokenOk(given: unknown): boolean {
	if (!authToken) return true;
	if (typeof given !== "string") return false;
	const a = Buffer.from(given);
	const b = Buffer.from(authToken);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function liveOpen(ws: LiveSocket): void {
	liveClients.set(ws, { authed: false });
}

/** The page's one frame: {type:"live:watch", token?, session?}. */
export function liveMessage(ws: LiveSocket, raw: string): void {
	const c = liveClients.get(ws);
	if (!c) return;
	let m: Record<string, unknown>;
	try {
		m = obj(JSON.parse(raw));
	} catch {
		return;
	}
	if (m.type !== "live:watch") return;
	if (!tokenOk(m.token)) {
		ws.send(JSON.stringify({ type: "live:error", message: "unauthorized" }));
		return;
	}
	c.authed = true;
	c.session = str(m.session);
	push(ws, c);
}

export function liveClose(ws: LiveSocket): void {
	liveClients.delete(ws);
}

let mermaidJs: string | null = null;

function mermaidScript(): Response {
	try {
		mermaidJs ??= readFileSync(
			Bun.resolveSync("mermaid/dist/mermaid.min.js", import.meta.dir),
			"utf8",
		);
	} catch {
		return new Response("mermaid is not installed next to the daemon", { status: 503 });
	}
	return new Response(mermaidJs, {
		headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" },
	});
}

/** GET /live (the page) and /live/mermaid.js (the pinned local copy). Null for anything else. */
export function handleLiveHttp(req: Request, url: URL, loopback: boolean): Response | null {
	if (req.method !== "GET") return null;
	if (url.pathname !== "/live" && url.pathname !== "/live/mermaid.js") return null;
	// Served to this machine only, even when the daemon binds wider (8SO, 5844).
	if (!loopback) return new Response("forbidden: the live view is loopback-only", { status: 403 });
	if (url.pathname === "/live") {
		return new Response(LIVE_PAGE, {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
		});
	}
	if (url.pathname === "/live/mermaid.js") return mermaidScript();
	return null;
}

const LIVE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>8gent live anatomy</title>
<style>
:root{--bg:#0b0f14;--panel:#111827;--line:#1f2937;--text:#e5e7eb;--muted:#9ca3af;--run:#22c55e;--pause:#f59e0b;--fail:#ef4444;--done:#6b7280}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;gap:16px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:15px;margin:0;font-weight:600}.legend{display:flex;gap:12px;color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:middle}
#status{margin-left:auto;color:var(--muted)}
main{display:grid;grid-template-columns:1fr 380px;height:calc(100% - 45px)}
#graph{overflow:auto;padding:16px}#graph svg{max-width:none}
aside{border-left:1px solid var(--line);background:var(--panel);overflow:auto;padding:12px 14px}
aside h2{font-size:13px;margin:0 0 6px;word-break:break-all}aside .meta{color:var(--muted);margin-bottom:8px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:12px}.add{color:#86efac}.del{color:#fca5a5}
g.node{cursor:pointer}
@keyframes pulse{0%,100%{stroke-opacity:1;stroke-width:3px}50%{stroke-opacity:.35;stroke-width:6px}}
g.node.running rect,g.node.running polygon,g.node.running path,g.node.running circle{animation:pulse 1.1s ease-in-out infinite}
@media (max-width:800px){main{grid-template-columns:1fr;grid-template-rows:1fr 40%}aside{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<header><h1>8gent live anatomy</h1>
<div class="legend"><span><i class="dot" style="background:var(--run)"></i>running</span><span><i class="dot" style="background:var(--pause)"></i>paused</span><span><i class="dot" style="background:var(--fail)"></i>failed</span><span><i class="dot" style="background:var(--done)"></i>done</span></div>
<div id="status">connecting</div></header>
<main><div id="graph"></div><aside id="detail"><div class="meta">Click a node to see its last diff or output.</div></aside></main>
<script src="/live/mermaid.js"></script>
<script>
(function(){
  var graphEl=document.getElementById('graph'),detail=document.getElementById('detail'),status=document.getElementById('status');
  var nodes={},lastText='',selected=null,rendering=false,pending=null,seq=0;
  mermaid.initialize({startOnLoad:false,theme:'dark',securityLevel:'strict',flowchart:{htmlLabels:false}});
  var hash=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search);
  function text(t){return document.createTextNode(t)}
  function show(id){
    var n=nodes[id];if(!n)return;selected=id;detail.textContent='';
    var h=document.createElement('h2');h.appendChild(text(n.label));detail.appendChild(h);
    var m=document.createElement('div');m.className='meta';m.appendChild(text(n.kind+' - '+n.state+' - '+n.calls+' call(s)'+(n.lastTool?' - last: '+n.lastTool:'')));detail.appendChild(m);
    var body=n.diff||n.output||'';var pre=document.createElement('pre');
    if(n.diff){n.diff.split('\\n').forEach(function(l){var s=document.createElement('span');s.className=l[0]==='+'?'add':l[0]==='-'?'del':'';s.appendChild(text(l+'\\n'));pre.appendChild(s)})}
    else pre.appendChild(text(body||'(nothing recorded yet)'));
    detail.appendChild(pre);
  }
  function wire(){
    Object.keys(nodes).forEach(function(id){
      var el=graphEl.querySelector('[id*="flowchart-'+id+'-"]');
      if(el)el.addEventListener('click',function(){show(id)});
    });
  }
  function render(t){
    if(rendering){pending=t;return}
    rendering=true;
    mermaid.render('live'+(seq++),t).then(function(r){graphEl.innerHTML=r.svg;wire();if(selected)show(selected)})
      .catch(function(e){status.textContent='render error: '+e.message})
      .finally(function(){rendering=false;if(pending!==null){var p=pending;pending=null;render(p)}});
  }
  function connect(){
    var ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/live/ws');
    ws.onopen=function(){status.textContent='live';ws.send(JSON.stringify({type:'live:watch',token:hash.get('token')||undefined,session:query.get('session')||undefined}))};
    ws.onmessage=function(ev){
      var m=JSON.parse(ev.data);
      if(m.type==='live:error'){status.textContent=m.message;return}
      if(m.type!=='live:graph')return;
      nodes={};m.nodes.forEach(function(n){nodes[n.id]=n});
      if(m.mermaid!==lastText){lastText=m.mermaid;render(m.mermaid)}else if(selected)show(selected);
    };
    ws.onclose=function(){status.textContent='reconnecting';setTimeout(connect,1500)};
  }
  connect();
})();
</script></body></html>`;
