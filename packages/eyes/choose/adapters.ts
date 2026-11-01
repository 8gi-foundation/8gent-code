/**
 * Adapters from the two element sources we already have to ChoiceElement.
 * No perception code here: the rows come from 8gent Browser's page.query
 * (src/main/automation.ts queryElements) and from packages/eyes annotate().
 */
import type { AnnotatedElement } from "../types.js";
import type { ChoiceElement } from "./index.js";

/** One row of 8gent Browser's page.query result, as the browser returns it. */
export interface DomElementRow {
	index: number;
	tag: string;
	text: string;
	href?: string;
	rect: { x: number; y: number; w: number; h: number };
	visible: boolean;
}

/** DOM rows keep their enumeration index, which browser_task click/type take as `index`. */
export function fromDomElements(rows: DomElementRow[]): ChoiceElement[] {
	return rows.map((r) => ({
		index: r.index,
		role: r.tag,
		label: r.text || hrefTail(r.href),
		rect: r.rect,
		visible: r.visible,
	}));
}

/** AX rows get their array position as index; the AX id rides along in `id`. */
export function fromAxElements(rows: AnnotatedElement[]): ChoiceElement[] {
	return rows.map((r, i) => ({
		index: i,
		id: r.id,
		role: r.role,
		label: r.label ?? r.value ?? "",
		rect: { x: r.bbox.x, y: r.bbox.y, w: r.bbox.width, h: r.bbox.height },
		enabled: r.enabled,
	}));
}

function hrefTail(href?: string): string {
	if (!href) return "";
	const tail = href
		.replace(/[?#].*$/, "")
		.split("/")
		.filter(Boolean)
		.pop();
	return tail ? `link to ${tail}` : "";
}
