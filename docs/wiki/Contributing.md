# Contributing

How to run 8gent Code from source and send a change. The full guide is [CONTRIBUTING.md](../../CONTRIBUTING.md); this page is the short path plus the rules that most often decide whether a PR merges.

## Set up from source

8gent runs on Bun, not Node. Install [Bun](https://bun.sh) first.

```bash
git clone https://github.com/8gi-foundation/8gent-code.git
cd 8gent-code
bun install
bun run tui
```

`bun run tui` runs `apps/tui/src/index.tsx`. The TUI needs a real terminal; piped input stops with a raw-mode error (see [Troubleshooting](Troubleshooting)). Other entry points in `package.json`: `bun run cli` (`bin/8gent.ts`), `bun run daemon`, `bun run start`.

You need a model to talk to. See [docs/install/providers.md](../install/providers.md) for local servers and optional hosted keys, and [Configuration](Configuration) for settings.

## Branch and PR flow

1. Open or find a GitHub issue first. Every change links to one.
2. Branch from the current `origin/main`: `git fetch origin && git checkout -b feat/short-description origin/main`. Prefixes in use: `feat/`, `fix/`, `docs/`.
3. Never push directly to `main`. Always open a PR.
4. Open the PR with the base set explicitly: `gh pr create --base main`. A PR opened while another feature branch is checked out can otherwise target that branch.
5. Put `Closes #N` in the PR body.
6. Use a conventional PR title, for example `feat(scope): ...` or `fix(scope): ...`.

## Version and changelog: leave them alone

Do not edit `CHANGELOG.md` or the version in a PR. A release PR is opened automatically after merges to `main`; it builds the changelog from merged PR titles, so a clear title is your changelog entry. For a minor or major bump put `[bump:minor]` or `[bump:major]` in the PR title or body. Details: [docs/RELEASING.md](../RELEASING.md).

## Rules that CI or review will catch

- **Bun, not Node,** in scripts and tooling.
- **Principles gate.** Run `bun scripts/local-first-gate.ts` (or `bun run check:local-first`). It fails if a default path sends user data off the device, or runs or asks for a system package install. A new network host in shipped code must be added to the list in `scripts/local-first-sinks.ts` with the right mode. Read [docs/security/principles-gate.md](../security/principles-gate.md) before adding anything that talks to a server.
- **Typecheck and lint.** `bun run typecheck`, `bun run typecheck:tui`, and `bun run lint` must pass. See [Testing](Testing).
- **No em dashes** in code, docs or copy. Use a hyphen.
- **No secrets** in commits, issues or chat. Keys live in `~/.8gent/keys.env` or your environment.
- **No AI vendor attribution lines** in commits, PRs or code comments in this repo.

## TUI rules

The TUI is built from a primitive layer in `apps/tui/src/components/primitives/` on top of the tokens in `apps/tui/src/theme/`.

- In screens, compose primitives (`Stack`, `Inline`, `Card`, `Badge`, `MutedText`, and so on) instead of raw Ink `<Text>` and `<Box>`.
- Do not use `gray`, `white` or `black` as colors. Terminals differ too much. Use `dimColor` for muted text, `bold` for emphasis, `inverse` for badges, or the semantic tokens.
- No purple, pink or violet. Palette and typography are in [BRAND.md](../../BRAND.md).
- Put formatting in `apps/tui/src/lib/` (`truncate()`, `formatTokens()`, `formatDuration()`) rather than inline.

Color must also respect `NO_COLOR`; see [docs/guides/no-color.md](../guides/no-color.md).

## Where to add things

[CONTRIBUTING.md](../../CONTRIBUTING.md) walks through adding a tool (`packages/tools/`), a TUI component, a hook type, a bundled skill (with a proposal issue and security review), AST parsing, and personality. Update the relevant docs in the same PR.

## Before you open the PR

```bash
bun run typecheck && bun run typecheck:tui
bun run lint
bun scripts/local-first-gate.ts
bun test path/to/your.test.ts
```

Changes to the system prompt, assistant loop or tool system should also run the relevant benchmarks; see [CONTRIBUTING.md](../../CONTRIBUTING.md).
