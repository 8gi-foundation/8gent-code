# Principles gate

Two rules from the repo's principles are checked by CI, not by memory. Both use one mechanism: a list of known sinks, markers for the opt-in and fallback cases, and a failure whenever something new appears that is not on the list.

- Gate: `scripts/local-first-gate.ts` (`bun scripts/local-first-gate.ts`, or `bun run check:local-first`). CI runs it before the type check.
- The one list: `scripts/local-first-sinks.ts`.
- Tests: `packages/ci/local-first-gate.test.ts`.
- Audit of rule 1, path by path: `docs/security/off-device-data.md`.

Why: 8gent v0.20.26 asked a person on a phone to enable voice input through a speech service that can be Google's cloud, and its first run asked to run `pkg install` and `ollama pull`. James, 24 Oct: "Stop making these fatal deviations from our principles." And: "core needs to be one install and boom."

## Rule 1: local by default

A default path must never send user data off the device. User data means audio, prompt text, tool results, files, images, keys and usage.

Anything that can send must name its destination in the words the person sees and needs a yes: a key, a token, a login, or a typed command. Each entry in `SINKS` has a mode (`optin`, `command`, `default`, `pull`, `inert`) and, for `optin`, a guard: a pattern that must still match in a named file, so deleting the guard fails the build.

The gate fails when:

1. a hostname appears in shipped code (`packages/`, `apps/tui/`, `bin/`) that no entry covers;
2. a listed host or pattern is reached from a file its entry does not name;
3. an `optin` guard no longer matches;
4. a `default` entry, or a failed guard, has no waiver, or the waiver expired;
5. a file reads Ollama's `/api/tags` without the cloud-tag filter (`packages/core/ollama-cloud.ts`) and is not on the reviewed list;
6. a file starts `ollama serve` without `OLLAMA_NO_CLOUD`.

## Rule 2: one install, zero deps

A default code path must never require or run a system package install, and must never tell the person to run one. Core has to work after one install of 8gent.

What counts as an install: `pkg install`, `apt` or `apt-get install`, `dnf`, `yum`, `pacman`, `apk`, `brew install`, `scoop` or `choco` or `winget` installs, `pip install` (also `python3 -m pip install`), `pipx`, `cargo install`, `gem install`, `npm i -g` or `bun add -g` for anything other than 8gent itself, `ollama pull`, `ollama run`, `ollama serve` (including the `/api/pull` call and a `["serve"]` spawn), `cmake` and `make` builds, `xcode-select --install`, and the internal `installPkgs` runner. The patterns are `INSTALL_PATTERNS` in the list.

Allowed in two cases only:

- **Opt-in**: it runs only after an explicit command or a typed yes that names what is installed.
- **Fallback**: it is text shown after the person asked for a feature that is missing something. Nothing runs, and it is not on the first-run path.

Mark the code, on the same line or the line directly above it (a comment-only line):

```ts
// local-first-gate: optin only after the person typed /dj and said yes
// local-first-gate: fallback shown when voice input was requested and sox is missing
```

or list the file in `INSTALL_SITES` with its mode and a reason. A file listed as `default` is a known item and needs a waiver. Anything else that matches fails as a new install sink.

Outside the gate: `scripts/` (run by a person's own command), tests, comments, and installing 8gent itself.

The gate fails when:

7. install text appears in a file `INSTALL_SITES` does not list, with no marker;
8. a file listed as `default` has no waiver, or its waiver expired.

## Known items (waivers)

A waiver is a reference to an issue and an expiry date. After the date the gate fails, so a known item cannot go quiet.

- `web_search` on by default (rule 1): #4912, until 2026-11-07.
- Install text on default paths (rule 2): #4915, until 2026-11-07. The files are the `default` entries in `INSTALL_SITES`.

`bun scripts/local-first-gate.ts --no-waivers` ignores all waivers and shows what they are hiding. `--root <checkout>` runs the gate over another checkout, for example a pull request's tree.

## Adding a sink, or clearing a known item

- New host, provider, tool or first-run question that can send data: add one entry to `SINKS` in the same PR as the code, in the right mode, with a guard if data can leave, and a row in `docs/security/off-device-data.md`.
- New install or install text: put it behind an opt-in or fallback and mark it, or list the file.
- Fixing a known item: remove its waiver or `default` entry in the same PR. The gate warns when an entry is stale.

## What the gate cannot see

It reads text. A host built from pieces, a URL held in an environment variable, an install run by a dependency, or a message assembled at run time is invisible to it. The review checklist (`docs/security/review-checklist.md`) covers those, with the same two questions on every security review and second read.
