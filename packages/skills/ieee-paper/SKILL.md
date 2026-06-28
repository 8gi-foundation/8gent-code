---
name: ieee-paper
description: Write committee-grade, IEEE-conference-formatted academic papers (two-column IEEEtran, vector TikZ diagrams, booktabs tables) as compiled PDFs, about the user's own inventions, frameworks, systems, or policy proposals. Use this skill whenever the user wants to turn an idea, system, architecture, or argument into a formal paper, whitepaper, technical note, or "make it look like that IEEE paper" — including for academic submission, advisory-committee or Oireachtas distribution, or technical-credibility documents for 8GI/8gent. Trigger on requests like "write this up as a paper," "make a formal paper about X," "I want figures and proper formatting," or any mention of IEEE format, LaTeX papers, academic write-ups, or conference-style documents, even if LaTeX is not named explicitly. The output is always a real compiled PDF, not a markdown imitation.
---

# IEEE Paper Authoring

Produce a real IEEE-conference PDF — two-column `IEEEtran`, vector TikZ figures, `booktabs` tables — about the user's own work. The deliverable is a compiled `.pdf` (plus its `.tex` source), never a markdown stand-in. The bar is the quality of the *Loop Engineering* reference paper: layered tables, vector flow diagrams, a tight abstract, an honest failure-modes section.

## Environment setup (do this first, every time)

The IEEE document class is bundled with this skill because `tlmgr` is usually locked in the sandbox. Before compiling anything, run:

```bash
bash <skill_dir>/scripts/setup_ieee.sh
```

This installs `assets/IEEEtran.cls` into the local TeX tree (idempotent). If `pdflatex`/`latexmk` are somehow absent, tell the user the environment lacks a LaTeX toolchain and offer the `.tex` source plus an Overleaf-ready zip instead — do not silently fall back to a markdown "paper."

## Workflow

1. **Gather the spine before writing.** A good paper needs: a one-line falsifiable claim (the title), the contribution, the mechanism decomposed into named parts, at least one real case or number, and the honest limitations. If the user hasn't given these, pull them from the conversation/memory first, then ask only for what's genuinely missing — one tight round, not an interrogation. For the user's own inventions (8gent Jr, 8GI sovereignty thesis, FoodStack OS, policy green papers) much of this is already on record.

2. **Copy the template.** Start from `assets/template.tex` — copy it into the working directory as `paper.tex` and fill the `<<...>>` placeholders. Do not write IEEEtran boilerplate from scratch; the template already encodes the correct preamble, a consistent TikZ style block, and three figure patterns that compile.

3. **Write the prose, then the figures.** Match the reference paper's register: precise, declarative, no melodrama. Each section earns its place. The abstract names the thing, places it, decomposes it, ends on the carry-away sentence. See `references/structure-guide.md` for the section-by-section rhetorical pattern.

4. **Draw figures as vectors.** Every diagram is TikZ code, never a screenshot. The three bundled patterns (vertical stack, horizontal pipeline, full-width cycle) cover most needs. For anything else, consult `references/tikz-cookbook.md` — it has copy-paste recipes for block diagrams, state machines, layered architectures, comparison matrices, and data plots, all tested. Reuse the `gen`/`det` color convention (green = creative/probabilistic, blue = deterministic/rule-bound) for consistency.

5. **Compile and verify visually.** Run:
   ```bash
   bash <skill_dir>/scripts/build.sh <workdir>/paper.tex
   ```
   It compiles twice (resolving refs), surfaces real errors, and reports page count. Then **rasterize page 1** (`pdftoppm -png -r 100 -f 1 -l 1 paper.pdf pg`) and `view` it. Always eyeball the result — overfull boxes, a figure spilling the column, a broken `\ref` show up visually, not always in the log. Fix and recompile until it's clean.

6. **Present the PDF first**, source second. Lead `present_files` with the `.pdf`.

## Quality bar (what separates committee-grade from a LaTeX exercise)

- **Figures prove a point, captions state it.** A caption says what the figure *demonstrates*, not just what it depicts ("Deterministic gates and creative steps interlock; reliability comes from the constraints, not the model" — not "A diagram of the pipeline").
- **Tables use `booktabs`** (`\toprule/\midrule/\bottomrule`), never vertical rules or `\hline` spam.
- **One claim per sentence; real numbers over adjectives.** "1,300 PRs merged per week" beats "massive throughput."
- **Wide figures use `figure*`** to span both columns; never cram a wide diagram into one column.
- **An honest limits/costs section** is a credibility signal, not a weakness. The reference paper's four-costs catalog is the model.
- **No placeholder left behind.** Search the final `.tex` for `<<` before compiling the deliverable.

## Common failure modes (and the fix)

| Symptom | Cause | Fix |
|---|---|---|
| `File IEEEtran.cls not found` | setup not run / tlmgr locked | run `setup_ieee.sh`; build.sh also copies the cls beside the source |
| Figure overflows column | wide TikZ in `figure` | switch to `figure*`, or scale `\resizebox{\columnwidth}{!}{...}` |
| `Undefined control sequence` in TikZ | missing `\usetikzlibrary` | check the library list in the preamble (see cookbook) |
| `??` instead of figure number | single compile | build.sh runs latexmk which compiles twice — rerun it |
| Overfull \hbox warnings | long unbreakable tokens (URLs, code) | wrap in `\url{}` or `\texttt{}` with `\sloppy` |

## Detailed references

- `references/structure-guide.md` — section-by-section rhetorical pattern, abstract recipe, how to frame *your own* invention as a contribution without overclaiming.
- `references/tikz-cookbook.md` — tested, copy-paste vector-figure recipes beyond the three in the template.
- `assets/template.tex` — the annotated starting point (always begin here).
- `assets/IEEEtran.cls` — the bundled document class (installed by setup).
