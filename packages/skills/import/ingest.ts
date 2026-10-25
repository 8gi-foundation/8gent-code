/**
 * Consent, then ingest (#5037, slice 1).
 *
 * With an explicit yes, copies skills, instruction files and memory notes found by the scan into
 * ~/.8gent/imported/<tool>/..., each carrying provenance frontmatter (source tool, original path,
 * imported-at). Without a yes, nothing is written, not even a folder. Same-named skills are
 * deduped (first tool in TOOL_ORDER wins) and a bundled 8gent core skill always wins. An item
 * that points at an env var or an absolute path that does not exist on this machine is still
 * written, marked `needs-edit: <reason>`, and the skill loader skips it and shows the reason.
 * Only the files the scan listed are opened; secrets were never listed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { coreSkillKeys } from "../index.js";
import { importManifestPath, importedRoot } from "./paths.js";
import { type FoundItem, type ScanResult, TOOL_ORDER, type ToolId } from "./scan.js";

export interface IngestOptions {
	/** Explicit yes from the owner. Anything but `true` writes nothing. */
	consent: boolean;
	home: string;
	env?: Record<string, string | undefined>;
	now?: () => Date;
	/** Injectable for tests (records what was opened). */
	readFile?: (p: string) => string;
}

export interface ImportedRecord {
	tool: ToolId;
	kind: FoundItem["kind"];
	name: string;
	source: string;
	dest: string;
	status: "ok" | "needs-edit";
	reason?: string;
}

export interface IngestResult {
	consent: boolean;
	written: ImportedRecord[];
	/** Skills dropped because an earlier tool already brought a skill with that name. */
	deduped: { name: string; tool: ToolId; source: string; keptFrom: string }[];
	/** Skills dropped because a bundled 8gent core skill owns the name or trigger. */
	coreWon: { name: string; tool: ToolId; source: string }[];
	/** Kinds found but not brought home in this slice (commands). */
	pending: { tool: ToolId; kind: FoundItem["kind"]; count: number }[];
	manifestPath?: string;
}

interface Parsed {
	meta: Record<string, string>;
	body: string;
}

/** Tiny frontmatter reader: key: value lines, with `>` and `|` block scalars folded to one line. */
export function parseSourceFrontmatter(text: string): Parsed {
	const src = text.replace(/\r\n/g, "\n");
	const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/);
	if (!m) return { meta: {}, body: src };
	const meta: Record<string, string> = {};
	const lines = m[1].split("\n");
	for (let i = 0; i < lines.length; i++) {
		const km = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!km) continue;
		let v = km[2].trim();
		if (v === ">" || v === "|" || v === ">-" || v === "|-") {
			const parts: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
			v = parts.join(" ");
		}
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
			v = v.slice(1, -1);
		meta[km[1]] = v;
	}
	return { meta, body: m[2] ?? "" };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/"/g, "'").trim();

export function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "item";
}

const ENV_VAR = /\$\{?([A-Z][A-Z0-9_]+)\}?/g;
/** Placeholders other tools fill in at run time; not machine paths. */
const RUNTIME_PLACEHOLDERS = new Set(["ARGUMENTS"]);
const ABS_PATH =
	/(?:^|[\s"'`(=])(~\/[^\s"'`)<>|,;*{}\][]+|\/(?:Users|home)\/[^\s"'`)<>|,;*{}\][]+)/g;

/**
 * Why this text cannot run as written on this machine, or null. Looks for $VARS that are not set
 * and absolute or ~ paths that do not exist. At most three reasons, one line.
 */
export function needsEditReason(
	text: string,
	home: string,
	env: Record<string, string | undefined>,
	exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
	const reasons: string[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(ENV_VAR)) {
		const v = m[1];
		if (RUNTIME_PLACEHOLDERS.has(v) || seen.has(v)) continue;
		seen.add(v);
		if (env[v] === undefined) reasons.push(`references $${v}, which is not set on this machine`);
	}
	for (const m of text.matchAll(ABS_PATH)) {
		const raw = m[1].replace(/[.:]+$/, "");
		if (seen.has(raw)) continue;
		seen.add(raw);
		const abs = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
		if (!exists(abs)) reasons.push(`references ${raw}, which does not exist on this machine`);
	}
	return reasons.length > 0 ? reasons.slice(0, 3).join("; ") : null;
}

function frontmatter(fields: [string, string | undefined][]): string {
	return `---\n${fields
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n")}\n---\n`;
}

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, content, { mode: 0o600 });
}

export function ingest(scan: ScanResult, opts: IngestOptions): IngestResult {
	const result: IngestResult = {
		consent: opts.consent === true,
		written: [],
		deduped: [],
		coreWon: [],
		pending: [],
	};
	if (opts.consent !== true) return result;

	const env = opts.env ?? process.env;
	const now = (opts.now ?? (() => new Date()))().toISOString();
	const read = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
	const root = importedRoot(opts.home);
	const core = coreSkillKeys();
	const takenSkills = new Map<string, string>();
	const usedDest = new Set<string>();
	const freeDest = (dest: string): string => {
		let d = dest;
		for (let n = 2; usedDest.has(d); n++) d = dest.replace(/(\.[^.\/]+)$/, `-${n}$1`);
		usedDest.add(d);
		return d;
	};

	const tools = [...scan.tools].sort(
		(a, b) => TOOL_ORDER.indexOf(a.tool) - TOOL_ORDER.indexOf(b.tool),
	);
	for (const t of tools) {
		const commands = t.items.filter((i) => i.kind === "command").length;
		if (commands > 0) result.pending.push({ tool: t.tool, kind: "command", count: commands });

		for (const item of t.items) {
			if (item.kind === "command") continue;
			let text: string;
			try {
				text = read(item.path);
			} catch {
				continue;
			}
			const { meta, body } = parseSourceFrontmatter(text);
			const reason = needsEditReason(text, opts.home, env);
			const prov: [string, string][] = [
				["source-tool", item.tool],
				["source-path", item.path.replace(/\s+/g, " ")],
				["imported-at", now],
			];

			if (item.kind === "skill") {
				const name = (meta.name || item.name).trim();
				const key = name.toLowerCase();
				const slug = slugify(name);
				if (core.has(key) || core.has(slug)) {
					result.coreWon.push({ name, tool: item.tool, source: item.path });
					continue;
				}
				const kept = takenSkills.get(slug);
				if (kept) {
					result.deduped.push({ name, tool: item.tool, source: item.path, keptFrom: kept });
					continue;
				}
				takenSkills.set(slug, item.path);
				const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
				const dest = path.join(root, item.tool, "skills", slug, "SKILL.md");
				write(
					dest,
					frontmatter([
						["name", slug],
						[
							"description",
							oneLine(meta.description || firstLine).slice(0, 400) || `Imported from ${item.tool}`,
						],
						...prov,
						["needs-edit", reason ? oneLine(reason) : undefined],
					]) + body.replace(/^\n+/, ""),
				);
				result.written.push(record(item, name, dest, reason));
				continue;
			}

			const sub = item.kind === "memory" ? "memory" : "instructions";
			const rel = `${slugify(item.name.split("/")[0])}${item.name.includes("/") ? `__${slugify(item.name.split("/").slice(1).join("-"))}` : ""}.md`;
			const dest = freeDest(path.join(root, item.tool, sub, rel));
			write(
				dest,
				frontmatter([
					["name", oneLine(item.name)],
					["kind", item.kind],
					["description", oneLine(meta.description ?? "") || undefined],
					...prov,
					["needs-edit", reason ? oneLine(reason) : undefined],
				]) + body.replace(/^\n+/, ""),
			);
			result.written.push(record(item, item.name, dest, reason));
		}
	}

	const manifest = importManifestPath(opts.home);
	write(
		manifest,
		`${JSON.stringify(
			{
				version: 1,
				importedAt: now,
				items: result.written,
				deduped: result.deduped,
				coreWon: result.coreWon,
				pending: result.pending,
			},
			null,
			2,
		)}\n`,
	);
	result.manifestPath = manifest;
	return result;
}

function record(
	item: FoundItem,
	name: string,
	dest: string,
	reason: string | null,
): ImportedRecord {
	return {
		tool: item.tool,
		kind: item.kind,
		name,
		source: item.path,
		dest,
		status: reason ? "needs-edit" : "ok",
		...(reason ? { reason } : {}),
	};
}
