# Quarantine: Template Engine

## What

Mustache-style template engine (`packages/tools/template-engine.ts`, ~105 lines) for generating code, docs, or messages with `{{variable}}` substitution.

## Features

- `{{variable}}` - plain value substitution (dot-path supported: `{{user.name}}`)
- `{{#section}}...{{/section}}` - conditional blocks (truthy) and array iteration
- `{{^section}}...{{/section}}` - inverted blocks (render when falsy/empty)
- `{{! comment }}` - stripped from output
- `{{.}}` - current item in array iteration
- `extractVariables(tpl)` - list all placeholders in a template
- `renderFile(path, data)` - render from disk (Bun-native)

## API

```ts
import { render, renderFile, extractVariables } from "./packages/tools/template-engine.ts";

// Basic
render("Hello {{name}}", { name: "Eight" });
// => "Hello Eight"

// Conditional
render("{{#admin}}Admin panel{{/admin}}", { admin: true });
// => "Admin panel"

// Inverted
render("{{^items}}No items{{/items}}", { items: [] });
// => "No items"

// Array iteration
render("{{#tags}}[{{.}}] {{/tags}}", { tags: ["ai", "cli"] });
// => "[ai] [cli] "

// Dot paths
render("{{user.name}}", { user: { name: "James" } });
// => "James"

// Extract placeholders
extractVariables("{{name}} is {{role}}");
// => ["name", "role"]
```

## Use Cases

- Generating boilerplate code files from project templates
- Formatting system prompts with user context
- Producing markdown docs with dynamic data
- Building CLI output messages

## Graduation Criteria

- Wire into at least one real workflow (e.g., project scaffolder, prompt builder)
- Add tests covering edge cases (missing vars, nested sections, empty arrays)
- Confirm no overlap with existing packages

## Dependencies

None. Zero external deps. Uses only `Bun.file()` for the file helper.
