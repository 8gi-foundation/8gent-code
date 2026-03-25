# Quarantine: command-line-args

**Status:** Quarantined - pending integration review
**Package:** `packages/tools/command-line-args.ts`
**Added:** 2026-03-25

## What It Does

Parses `process.argv`-style arrays into typed options with full schema support. Exports `parseArgs` and `generateHelp`.

## API

```ts
import { parseArgs, generateHelp } from "./packages/tools/command-line-args";

const schema = {
  host:    { type: "string",  alias: "h", default: "localhost", description: "Server host" },
  port:    { type: "number",  alias: "p", default: 3000,        description: "Server port" },
  verbose: { type: "boolean", alias: "v",                       description: "Verbose output" },
  output:  { type: "string",              required: true,       description: "Output path" },
};

const { options, positionals, errors } = parseArgs(process.argv.slice(2), schema);

console.log(generateHelp(schema, "myapp"));
```

## Features

- Typed options: `string`, `number`, `boolean`
- Short aliases: `-p 8080`, long: `--port 8080`, inline: `--port=8080`
- Boolean flags: `--verbose`, `--no-verbose`
- Defaults applied before parsing
- Required field validation with error collection
- Positionals collected (bare tokens and post-`--` args)
- Help string generation from schema

## Integration Notes

- Zero dependencies - pure TypeScript
- No side effects - pure function, no `process.exit`
- Errors are returned, not thrown - caller decides how to handle
- Suitable for use in agent tools, CLI scripts, and sub-commands

## Rejection Criteria

- If a more complete arg parser already exists in the codebase (check `packages/tools/`)
- If the project adopts a third-party CLI framework that handles this natively
