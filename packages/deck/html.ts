/**
 * 8gent Code - one Marp slide as a self-contained 1920x1080 HTML page.
 *
 * A deliberately small markdown renderer (headings, paragraphs, lists, tables,
 * fenced code, blockquotes, inline code/bold/italic/links). No network: fonts
 * fall back to installed families so the render is the same offline.
 * Palette is BRAND.md dark mode; no hues in the 270-350 band.
 */

import type { DeckSlide } from "./parse";

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function renderInline(text: string): string {
	const spans: string[] = [];
	const lifted = text.replace(/`([^`]+)`/g, (_m, code: string) => {
		spans.push(`<code>${escapeHtml(code)}</code>`);
		return `\uE000${spans.length - 1}\uE000`;
	});
	return escapeHtml(lifted)
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<span class="link">$1</span>')
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1<strong>$2</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/(^|[^\w])_(.+?)_(?!\w)/g, "$1<em>$2</em>")
		.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => spans[Number(n)] ?? "");
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

function alignments(divider: string): string[] {
	return cells(divider).map((c) =>
		c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
	);
}

/** Markdown blocks to HTML. */
export function renderMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const g = FENCE.exec(lines[i]);
				if (g && g[1][0] === fence[1][0] && g[1].length >= fence[1].length && !g[2]) {
					i++;
					break;
				}
				body.push(lines[i]);
				i++;
			}
			const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : "";
			out.push(`<pre${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
			continue;
		}
		if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
			const head = cells(line);
			const align = alignments(lines[i + 1]);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) {
				rows.push(cells(lines[i]));
				i++;
			}
			const th = head
				.map((c, k) => `<th style="text-align:${align[k] ?? "left"}">${renderInline(c)}</th>`)
				.join("");
			const tr = rows
				.map(
					(r) =>
						`<tr>${head
							.map(
								(_h, k) =>
									`<td style="text-align:${align[k] ?? "left"}">${renderInline(r[k] ?? "")}</td>`,
							)
							.join("")}</tr>`,
				)
				.join("");
			out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`);
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			out.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
			i++;
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			const ordered = /\d/.test(item[2]);
			const tag = ordered ? "ol" : "ul";
			const items: string[] = [];
			while (i < lines.length) {
				const it = LIST_ITEM.exec(lines[i]);
				if (it) {
					const nested = it[1].length >= 2 ? ' class="nested"' : "";
					items.push(`<li${nested}>${renderInline(it[3])}`);
					i++;
				} else if (lines[i].trim() !== "" && /^\s+/.test(lines[i]) && items.length > 0) {
					items[items.length - 1] += ` ${renderInline(lines[i].trim())}`;
					i++;
				} else break;
			}
			out.push(`<${tag}>${items.map((x) => `${x}</li>`).join("")}</${tag}>`);
			continue;
		}
		if (/^>\s?/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) {
				body.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			out.push(`<blockquote>${renderInline(body.join(" "))}</blockquote>`);
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!FENCE.test(lines[i]) &&
			!/^(#{1,6})\s/.test(lines[i]) &&
			!LIST_ITEM.test(lines[i]) &&
			!/^\s*\|/.test(lines[i]) &&
			!/^>/.test(lines[i])
		) {
			para.push(lines[i].trim());
			i++;
		}
		// A setext underline turns the paragraph into a heading.
		if (i < lines.length && /^(=+|-+)\s*$/.test(lines[i]) && para.length > 0) {
			const level = lines[i].trim().startsWith("=") ? 1 : 2;
			out.push(`<h${level}>${renderInline(para.join(" "))}</h${level}>`);
			i++;
			continue;
		}
		out.push(`<p>${renderInline(para.join(" "))}</p>`);
	}
	return out.join("\n");
}

const CSS = `
:root{--bg0:#0A0908;--bg1:#12100E;--bg2:#1C1A17;--bg3:#252220;--text:#FAF7F4;--text2:#C8C2BA;--text3:#8A8078;--border:#2E2A26;--accent:#F07A28}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden;background:var(--bg0)}
body{color:var(--text);font-family:"Inter",-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.frame{position:absolute;inset:0;padding:96px 128px 120px;display:flex;flex-direction:column;justify-content:center;background:radial-gradient(ellipse at 85% 0%,#1C1A17 0%,#0A0908 60%)}
.frame::before{content:"";position:absolute;left:0;top:0;bottom:0;width:12px;background:var(--accent)}
#content{font-size:40px;line-height:1.4;max-height:100%}
#content>*+*{margin-top:0.6em}
h1,h2,h3,h4,h5,h6{font-family:"Fraunces",Georgia,"Times New Roman",serif;font-weight:700;line-height:1.1;letter-spacing:-0.01em}
h1{font-size:2.3em;color:var(--text)}
h2{font-size:1.5em;color:var(--accent)}
h3{font-size:1.2em;color:var(--text2)}
h4,h5,h6{font-size:1em;color:var(--text2)}
p{color:var(--text2)}
strong{color:var(--text);font-weight:650}
em{color:var(--text)}
.link{color:var(--accent);text-decoration:underline}
ul,ol{padding-left:1.3em;color:var(--text2)}
li+li{margin-top:0.3em}
li.nested{margin-left:1.2em;font-size:0.9em}
ul li::marker{color:var(--accent)}
ol li::marker{color:var(--accent);font-weight:600}
code{font-family:"JetBrains Mono","SF Mono",Menlo,Monaco,monospace;font-size:0.85em;background:var(--bg3);color:#F5C99B;padding:0.08em 0.3em;border-radius:6px}
pre{background:var(--bg1);border:2px solid var(--border);border-left:6px solid var(--accent);border-radius:12px;padding:0.8em 1em;overflow:hidden}
pre code{background:none;padding:0;color:var(--text);font-size:0.8em;line-height:1.5;white-space:pre}
table{border-collapse:collapse;width:100%;font-size:0.8em;background:var(--bg1);border:2px solid var(--border);border-radius:12px;overflow:hidden}
th{background:var(--bg3);color:var(--accent);font-weight:650;border-bottom:2px solid var(--accent)}
th,td{padding:0.45em 0.7em;vertical-align:top}
td{color:var(--text2);border-top:1px solid var(--border)}
tbody tr:nth-child(even) td{background:var(--bg2)}
blockquote{border-left:6px solid var(--accent);padding-left:0.8em;color:var(--text2);font-style:italic}
.foot{position:absolute;left:128px;right:128px;bottom:44px;display:flex;justify-content:space-between;font-size:24px;color:var(--text3)}
.mark{font-family:"Fraunces",Georgia,serif;font-weight:800;color:var(--text2)}
.mark b{color:var(--accent)}
`;

/**
 * Shrinks the content until it fits the frame. Runs synchronously before the
 * load event, so the screenshot always sees the final size.
 */
const FIT = `(function(){var c=document.getElementById("content"),f=document.querySelector(".frame");var s=40;function over(){return c.scrollHeight>f.clientHeight-216||c.scrollWidth>c.clientWidth+1}while(over()&&s>14){s-=1;c.style.fontSize=s+"px"}})();`;

export function slideHtml(slide: DeckSlide, total: number): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Slide ${slide.index}</title><style>${CSS}</style></head>
<body><div class="frame"><div id="content">${renderMarkdown(slide.markdown)}</div></div>
<div class="foot"><span class="mark">8gent<b>.</b></span><span>${slide.index} / ${total}</span></div>
<script>${FIT}</script></body></html>`;
}
