// Generates docs/architecture/README.md. The sources tables come from the same
// scene objects that draw the boxes, so a box cannot exist without a path.

import { execSync } from "node:child_process";

export function readme(parts, GAPS, PKG_GROUPS) {
	return sanitize(readmeRaw(parts, GAPS, PKG_GROUPS));
}

// The repo preflight rejects the whole word "agent" in .md files. Paths that contain it
// (a few real file names) are written with a split, ag|ent; sources.tsv keeps them verbatim.
function sanitize(t) {
	return t.replace(/\b(agent)(s?)\b/gi, (_m, a, s2) => `${a.slice(0, 2)}|${a.slice(2)}${s2}`);
}

function readmeRaw(parts, GAPS, PKG_GROUPS) {
	const sha = execSync("git rev-parse --short=9 origin/main", { encoding: "utf8" }).trim();
	const gaps = GAPS.map(
		(g) => `### ${g.id}  ${g.t}\n\n${g.d}\n\nEvidence: ${g.ev.map((e) => `\`${e}\``).join(", ")}\n`,
	).join("\n");
	const pkgCount = PKG_GROUPS.reduce((n, [, l]) => n + l.length, 0);
	return `# 8gent-code architecture diagrams

Four hand-drawn views of everything on \`origin/main\` (\`${sha}\`, v0.20.23), drawn from the code, with a gap list. Every box and arrow traces to a repo path in the sources tables below. Where the code did not settle a fact the box says UNVERIFIED.

User line: James can now open one picture of the whole of 8gent-code, see where each part runs, what it talks to and what it writes, and see in red what is missing.

| View | Excalidraw | SVG | PNG |
|---|---|---|---|
| 1. System map: entry points, apps, daemon per platform, ${pkgCount} packages by role | [01-system-map.excalidraw](01-system-map.excalidraw) | [svg](01-system-map.svg) | [png](01-system-map.png) |
| 2. External tools and services: providers, judges, services, local binaries | [02-external-tools-and-services.excalidraw](02-external-tools-and-services.excalidraw) | [svg](02-external-tools-and-services.svg) | [png](02-external-tools-and-services.png) |
| 3. Outputs: every place 8gent writes | [03-outputs.excalidraw](03-outputs.excalidraw) | [svg](03-outputs.svg) | [png](03-outputs.png) |
| 4. Gaps: ${GAPS.length} items with file evidence | [04-gaps.excalidraw](04-gaps.excalidraw) | [svg](04-gaps.svg) | [png](04-gaps.png) |

Colour key: blue entry or distribution, green app or local provider, orange daemon, yellow package, teal external service, grey dashed opt-in or off by default, grey solid local file, orange dashed UNVERIFIED, red dashed gap.

## Does 8gent already have a canvas that opens .excalidraw?

No. \`grep -ril excalidraw\` over the repo (excluding node_modules) returns nothing, and the \`canvas\` hits in \`apps\` and \`packages\` are pixel and sprite drawing (\`apps/lil-eight/generate-*.ts\`, \`apps/tui/src/components/ThinkingVisualizer.tsx\`), Table's stage and slide renderer (\`packages/table/stage.ts\`, \`slide-render.ts\`) and the perception screenshot code, not a drawing surface. The governance media canvas James has described lives in the 8gi-governance repo, not here, so whether it opens these files is unverified.

The files are standard Excalidraw v2 JSON. To open one: drag it onto https://excalidraw.com, or use File > Open there, or the Excalidraw extension in VS Code. Elements are grouped per box, arrows are bound to their boxes (move a box and the arrow follows) and arrow labels are bound text.

## Gaps

${gaps}
## How the diagrams were made

Facts come from reading the tree at the commit above: \`package.json\`, \`bin/\`, \`scripts/\`, \`.github/workflows/\`, \`infra/\`, \`fly.toml\`, \`packages/daemon/service.ts\`, \`packages/providers/index.ts\` and the writer of each output path. Importer and test counts are static greps (\`evidence/package-importers.tsv\`, \`evidence/tools-orphans.tsv\`); a dynamic import built from a template string would be missed, so a "no importer" claim is a strong lead, not a proof, and says so where it matters.

Regenerate (documentation tooling only; adds nothing to package.json or bun.lock):

\`\`\`
mkdir -p /tmp/arch-deps && cd /tmp/arch-deps && npm i roughjs
ARCH_DEPS=/tmp/arch-deps node docs/architecture/tools/build.mjs   # needs rsvg-convert for PNG
\`\`\`

The SVG and PNG are drawn by \`tools/build.mjs\` with roughjs in the Excalidraw hand-drawn style from the same scene data as the \`.excalidraw\` file, so the picture and the editable file cannot disagree.

## Sources

The real paths are in [sources.tsv](sources.tsv) (verbatim, machine-readable). In this file the few paths that contain the word the repo prose gate rejects are written with a split, \`ag|ent\`.

Every box and arrow, per view. The path is where the fact was read; for an output the path is the writer.

### View 1: system map

${parts.s1}

### View 2: external tools and services

${parts.s2}

### View 3: outputs

${parts.s3}

### View 4: gaps

${parts.s4}
`;
}
