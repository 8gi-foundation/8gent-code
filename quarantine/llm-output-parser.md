# llm-output-parser

Extracts structured data (JSON, lists, key-value pairs) from unstructured LLM text output.

## Requirements
- extractJSON(text): finds and parses first valid JSON block in text
- extractList(text): extracts bulleted or numbered lists as string[]
- extractKeyValues(text): parses Key: Value patterns into object
- extractCodeBlocks(text): returns all fenced code blocks with language
- parseStructured(text, schema): best-effort schema extraction

## Status

Quarantine - pending review.

## Location

`packages/tools/llm-output-parser.ts`
