# Agentation - Layout Mode Analysis

## Source

- Author: Benji Taylor (@benjitaylor)
- Repo: github.com/benjitaylor/agentation
- Site: agentation.com
- License: PolyForm Shield 1.0.0
- Version: v3.0 (Layout Mode), npm package `agentation`

## What It Is

Agentation is a visual feedback tool for AI coding agents. It started as a click-to-annotate overlay for React apps - you click an element, add a note, and copy structured output (selectors, positions, bounding boxes) that an agent can use to locate and modify code.

Layout Mode (v3.0) extends this from feedback-only to spatial design. Press L, and the page becomes a canvas where you can:

1. **Drag-and-drop components** from a 65+ type palette (Layout, Content, Controls, Elements, Blocks)
2. **Rearrange existing sections** - hover reveals CSS selectors, drag reorders
3. **Wireframe new pages** - fade the current page, sketch from scratch with an opacity slider to reference what exists

## Core Pattern

The fundamental insight: **structured spatial intent beats natural language for layout**. Instead of "move the pricing table above the testimonials and add a hero section," you drag components to positions and the tool outputs coordinates, dimensions, and component types as machine-readable data.

## Annotation Format Schema (AFS 1.1)

Annotations carry a `kind` field with three values:

| Kind | Purpose | Data |
|------|---------|------|
| `feedback` | Click-to-annotate notes | Selector, position, note text, computed styles |
| `placement` | New component dropped on canvas | Component type, pixel dimensions, position |
| `rearrange` | Existing section moved | Original selector, new position, reorder sequence |

Output modes: Compact (selector + note), Standard (+ position + text), Detailed (+ bounding boxes + context), Forensic (+ computed styles).

## What We Can Extract for Eight

Agentation is a browser-side React component - not directly usable in a TUI or for reviewing generated code. But the pattern is valuable:

**Extractable concept: Structured layout feedback from code analysis.**

Instead of Agentation's visual approach (click on rendered page), Eight can analyze HTML/JSX/component structures statically and produce the same kind of structured feedback:

- Spacing inconsistencies (mixed units, missing gaps, uneven margins)
- Alignment issues (siblings with mismatched alignment strategies)
- Hierarchy problems (heading levels skipped, no visual weight progression)
- Component structure issues (deeply nested wrappers, missing semantic elements)
- Accessibility gaps (missing landmarks, contrast issues in token values)

This is a 100-150 line static analyzer, not a visual overlay. It serves the same purpose - giving Eight structured, actionable design feedback on UI code it generates - without needing a browser runtime.

## Rebuild Estimate

- **Core pattern:** Static layout analysis producing structured feedback
- **Can rebuild in <200 lines:** Yes, ~130 lines
- **Solves a real problem:** Yes - Eight generates UI (TUI components, HTML artifacts) and has no way to self-review layout quality
- **Smallest proof:** Single function that takes HTML/JSX string, returns typed feedback array

## Not Doing

- Not adopting the React overlay component
- Not building a visual drag-and-drop system
- Not implementing the MCP server / real-time annotation pipeline
- Not supporting rendered-page analysis (that requires a browser)
