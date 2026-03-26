# tool-registry

Registry for LLM tool definitions with validation.

## Requirements
- ToolRegistry stores name -> {description, schema, handler}
- register(tool) adds with schema validation
- get(name) retrieves handler
- toOpenAITools() returns OpenAI-compatible tool array
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/tool-registry.ts`
