import type { AppManifest } from "./manifest.js";

export function renderSkillTemplate(m: AppManifest): string {
	const slug = m.name;
	const trigger = `/app:${slug}`;
	return `---
name: app-${slug}
description: ${m.description} Iteration loop for the personal app "${slug}". Use when the user invokes ${trigger} or asks to refine, test, or extend this app.
trigger: ${trigger}
tools: [read, edit, write, bash]
---

# ${slug}

This SKILL teaches the agent how to iterate on the personal app at \`apps/${slug}/\`. The app was scaffolded by the mini-app authoring flow. Treat the four files inside as the contract: \`manifest.json\` declares the surface, \`index.ts\` implements it, \`SKILL.md\` (this file) drives iteration, and \`tests/\` holds the harness.

## Iteration loop (describe -> generate -> test -> refine)

1. **Describe.** Read \`manifest.json\` and the current \`index.ts\` first. Restate in one sentence what the app currently does and what the user wants changed. Do not skip this step. If the request is fuzzy, ask one focused clarifying question before editing.
2. **Generate.** Edit \`apps/${slug}/index.ts\`. Keep the default export shape (\`{ run(input, ctx) }\`). Update \`manifest.json\` only if the contract genuinely changes (capabilities, entry point, version bump). Bump version per SemVer.
3. **Test.** Run \`bun test apps/${slug}/tests/\`. If the change extends behavior, add a test in \`tests/index.test.ts\` first. Tests are the proof, not vibes.
4. **Refine.** If tests fail, fix root cause. Do not silence assertions. If tests pass, summarize the diff in one paragraph and stop.

## Capability discipline

The app declares its capabilities in \`manifest.json\` (\`${m.capabilities.length === 0 ? "none yet" : m.capabilities.join(", ")}\`). Do not call tools outside that allowlist. If the iteration genuinely needs a new capability, add it to the manifest first, get user confirmation, then implement.

## Manifest invariants

- \`name\`: never rename. The directory name is the identity.
- \`version\`: bump on every behavior change. Patch for fixes, minor for additions, major for contract breaks.
- \`entry\`: stays at \`index.ts\` unless splitting into modules. The runtime loads \`apps/${slug}/<entry>\`.
- \`publish\`: \`personal\` apps stay in \`~/.8gent/apps/\`. \`publishable\` apps are submission candidates - separate flow, not this loop.

## Failure modes to avoid

- Editing \`tests/\` to make red tests green.
- Adding capabilities silently. The manifest is the contract.
- Rewriting \`index.ts\` from scratch when a surgical edit would do.
- Skipping the describe step. Most regressions start there.

## When to stop

The loop ends when (a) tests pass, (b) the manifest matches the new behavior, and (c) you can summarize the change in one paragraph. Anything more is scope creep - flag it and ask the user.
`;
}

export function renderEntryTemplate(m: AppManifest): string {
	const slug = m.name;
	return `/**
 * ${slug} - personal mini-app.
 *
 * The runtime calls run({ input, ctx }) and forwards input from the user.
 * ctx.log streams to the TUI; ctx.capabilities lists what the manifest allows.
 * Keep this small. Iteration happens through SKILL.md, not by growing this file.
 */

export interface AppContext {
	log: (line: string) => void;
	capabilities: readonly string[];
}

export interface AppRunResult {
	ok: boolean;
	output: string;
	data?: unknown;
}

export interface AppRunArgs {
	input: string;
	ctx: AppContext;
}

export async function run({ input, ctx }: AppRunArgs): Promise<AppRunResult> {
	ctx.log(\`[${slug}] received input: \${input || "(empty)"}\`);
	return {
		ok: true,
		output: \`${slug} v${m.version} ran with input: \${input || "(none)"}\`,
	};
}

export default { run };
`;
}

export function renderTestTemplate(m: AppManifest): string {
	const slug = m.name;
	return `import { describe, expect, test } from "bun:test";
import { run } from "../index.js";

describe("${slug}", () => {
	const ctx = {
		log: (_line: string) => {},
		capabilities: ${JSON.stringify(m.capabilities)} as const,
	};

	test("returns ok for empty input", async () => {
		const r = await run({ input: "", ctx });
		expect(r.ok).toBe(true);
		expect(r.output).toContain("${slug}");
	});

	test("includes input in output", async () => {
		const r = await run({ input: "hello", ctx });
		expect(r.output).toContain("hello");
	});
});
`;
}

export function renderReadmeStub(m: AppManifest): string {
	return `# ${m.name}

${m.description}

Personal 8gent mini-app. Iteration is driven by \`SKILL.md\`. Run tests with \`bun test apps/${m.name}/tests/\`.

- Version: \`${m.version}\`
- Entry: \`${m.entry}\`
- Capabilities: ${m.capabilities.length === 0 ? "(none)" : m.capabilities.map((c) => `\`${c}\``).join(", ")}
- Publish: \`${m.publish}\`
`;
}
