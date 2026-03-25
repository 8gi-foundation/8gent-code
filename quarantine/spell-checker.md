# spell-checker

## Tool Name
`SpellChecker` - `packages/tools/spell-checker.ts`

## Description
Basic spell checker using Levenshtein edit distance to detect misspellings and suggest corrections. Ships with a built-in ~500-word dictionary covering common English words and programming terminology. Ignores camelCase, PascalCase, SCREAMING_CASE, snake_case, and alphanumeric identifiers so it does not flag code symbols.

## API

```ts
import { SpellChecker } from "./packages/tools/spell-checker";

const checker = new SpellChecker({ maxSuggestions: 3, maxDistance: 2 });

// Add project-specific terms
checker.addWords(["8gent", "ollama", "qwen", "bun"]);

// Check a single word
const result = checker.check("recieve");
// { word: "recieve", correct: false, suggestions: ["receive"] }

// Check all words in a block of text
const errors = checker.checkText("This is an exmaple of misspeled text.");
// [{ word: "exmaple", ... }, { word: "misspeled", ... }]
```

## Status
**quarantine** - self-contained utility, no external dependencies.

## Integration Path
1. Wire into the agent's text output pipeline to flag typos in generated prose.
2. Expose as a tool via `packages/eight/tools.ts` for document-generation tasks.
3. Optionally expand the dictionary from a proper word list file for better coverage.
4. Could surface spelling warnings on user-written prompts in the TUI.

## Out of Scope (for now)
- No grammar checking.
- No language detection.
- No phonetic matching (Soundex/Metaphone) - pure edit distance only.
- No external word list files - dictionary is bundled to keep the tool self-contained.
