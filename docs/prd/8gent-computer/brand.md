# 8gent Computer: Brand Narrative

Owner: Zara (8MO). Locks the narrative layer for PRD #1746. Pairs with #1750.

Status: draft for James approval. Do not merge without sign-off.

---

## 1. Product name usage guide

The canonical product name is **8gent Computer**. Proper noun. Two capitals. One space.

### Rules

| Context | Correct | Wrong |
|---------|---------|-------|
| Prose, headlines, blog posts, decks | `8gent Computer` | `8gentcomputer`, `8gent-computer`, `8gent-Computer`, `8gent computer` |
| File paths in the monorepo | `apps/8gent-computer/` | `apps/8gentcomputer/`, `apps/8gent_computer/` |
| Package names | `8gent-computer`, `@8gi-foundation/8gent-computer` | `8gentcomputer`, `@8gi/8gentComputer` |
| Xcode target / bundle id | `com.8gent.computer` | `com.8gent.Computer` |
| Social handles and domain subpaths | `8gent.dev/computer`, `@8gentcomputer` only if the space is forbidden by the platform | never introduce a new spelling in copy |

### When the space is not allowed

Some platforms (bundle identifiers, npm package names, URL slugs) forbid spaces. In those cases, hyphenate: `8gent-computer`. Never concatenate. Never camelCase. Never mix.

### In customer-facing copy

First reference in any doc, post, or page spells it in full: **8gent Computer**. Subsequent references in the same piece may shorten to `the Computer` (capitalised, treated like `the iPhone`). Never shorten to `8gent` on its own, because `8gent` is the umbrella brand.

---

## 2. Tagline candidates

Five options. Sorted worst to best. The winner is option 5.

1. **The computer that computes for you.** Cute. Too soft. Does not say what is different.
2. **Your Mac, with a brain.** Leans on Mac. Weakens the counter-position to Codex, which also runs on Mac.
3. **The agent is the computer.** Direct. The Apple Computer to Apple parallel is legible to anyone old enough to remember. Short enough for a hero.
4. **Body and brain, on your machine.** Names the dichotomy we are collapsing. Plain words. Does not need the reader to know Codex exists.
5. **Your computer, finally one of the team.** Winner. Frames the shift from tool to teammate without naming AI. Passes the no-vendor-trace rule. Survives the copy audit. Readable out loud. No jargon. Works as a hero. Works as a subject line.

### Pick

**Headline for launch: `Your computer, finally one of the team.`**

Subhead (use under the headline where the hero supports a second line):

> **Body and brain. Local first. Under your policy.**

Three nouns. Three things Codex cannot say without an asterisk.

### Backup rotation

For posts and decks that need a second-person variant:

- **Your computer, working with you now, not for you.**
- **Your Mac just got hands.** Not a headline. A demo caption for the 8gent-hands clip.

---

## 3. Positioning vs Codex

Anthropic is building the brain. Tools, protocols, events, MCP. The intelligence layer of the stack.

OpenAI is building the body. Codex, desktop agent, computer use, direct action on the machine.

Both bets are rational. Neither is enough.

A brain without a body is a chat window. A body without a brain is a macro recorder with better marketing. The customer does not want either. They want a coworker who can think and act, on their machine, under their rules.

8gent Computer is both. The body is `8gent-hands`, the computer-use layer. The brain is orchestration, memory, MCP, and HyperAgent, already shipped in `8gent-code`. The frame is Apple Computer to Apple: the agent is the computer, not an app stapled to it.

We do not describe Codex as wrong. We describe the industry as split. We are the ones not splitting it.

---

## 4. Launch one-pager (~150 words)

For the 8gent.dev hero, the release blog, and the PDF share. Copy below is the source of truth.

> # Your computer, finally one of the team.
>
> 8gent Computer runs on your Mac. It sees your screen, reads your files, clicks the buttons, and answers the messages. It remembers what you did last week. It checks in when a task finishes. It waits for your go-ahead on anything that touches a new app.
>
> The industry has split the agent in two. One camp builds the brain. The other builds the body. 8gent Computer is both.
>
> Local first. Your data stays on your machine, encrypted at rest. Cloud is opt-in, never default. Every action it takes is under your policy and in your log.
>
> Works next to your terminal, your browser, and your existing tools. No new password. No new dashboard. Just one more teammate, living in the menubar.
>
> 8gent Computer. Mac. Free and open source. Download today.

Word count: 147.

### Why this copy passes the audit

- Zero em dashes.
- Zero enthusiasm inflation. No `revolutionary`, no `game-changing`, no `transformative`, no `unleash`.
- Zero vendor names. No `Claude`, no `Anthropic`, no `OpenAI`, no `Codex`.
- Zero fabricated biography. No claim about James, no claim about users, no invented stats.
- Short declarative sentences. Periods doing the work.
- States what it does. States what is different. States what is local.

---

## 5. Copy audit ruleset

Applies to every customer-visible string that uses the name 8gent Computer. Blog, release notes, hero, modal, button, error, email, deck, PDF, social post.

### Five dos

1. **Do use the canonical spelling.** `8gent Computer`, first reference in full, every time.
2. **Do lead with outcome.** What the customer gets, not what the tech does. `reads your files` beats `leverages filesystem access`.
3. **Do use short declarative sentences.** Periods. Periods. Periods. The reader decides the feeling.
4. **Do respect the warm palette.** Primary orange `#E8610A`, warm neutrals, earth tones. Amber on amber-absent grammar for status.
5. **Do cite evidence when you claim a number.** If a benchmark number appears, link the run. If a user count appears, name the method.

### Five don'ts

1. **Do not use em dashes.** None. Not in body copy, not in headlines, not in captions. Use a colon, a comma, or rewrite. This rule is global across 8GI.
2. **Do not use banned hues.** Purple, pink, violet, magenta. Hues 270 to 350 are forbidden in any surface that ships the 8gent Computer name.
3. **Do not name the vendor.** No `Claude`, `Anthropic`, `OpenAI`, `GPT`, `Gemini`, `ChatGPT`, `Codex` in customer-facing copy. Internal docs, code comments, and engineering READMEs may name vendors. The line is whether a non-team-member reads the string.
4. **Do not inflate.** Banned words: `revolutionary`, `game-changing`, `transformative`, `unleash`, `empower`, `supercharge`, `next-generation`, `disrupt`, `paradigm shift`, `reimagine`. If the work is good, the reader will know. If the work is not good, the adjectives will not save it.
5. **Do not expose workflow language.** No `Export for AI`, `Send to Claude`, `Copy for prompt`, `AI feedback loop`. The customer is the subject of the verb. `Submit feedback`. `Send bug report`. `Share notes`.

### Voice lineage

The Infinite Gentleman voice is the parent brand. Calm, precise, not in a hurry, not performing. 8gent Computer inherits this voice in every surface. Think of the copy as something a senior colleague would write after a second coffee. Not a pitch deck. Not a press release. A note that respects the reader.

---

## 6. Review checklist before any surface ships

- [ ] Spelling is `8gent Computer` on first reference.
- [ ] No em dashes. Grep the file for the unicode codepoint `U+2014`. Zero hits.
- [ ] No banned hue in any asset or gradient. Run through the BRAND.md palette.
- [ ] No vendor name in customer-visible copy.
- [ ] No inflation words. Grep the file for the banned list above. Zero hits.
- [ ] Headline survives the out-loud test. Read it. If it sounds like a pitch, rewrite.
- [ ] Every claim that uses a number has a link or a citation.
- [ ] First reference in a shared piece explains what the product is in one sentence, not the tagline.

---

## 7. Surfaces this applies to at launch

- `8gent.dev` homepage hero (when the Computer launches)
- `8gent.dev/computer` product page
- Release blog on `8gent.world`
- README on `apps/8gent-computer/README.md`
- Menubar copy inside the app itself (consent sheet language, notification strings, settings labels)
- Launch posts on Threads, X, LinkedIn
- Any deck, PDF, or video caption that ships the name

---

## 8. Open items

- Final James approval on tagline `Your computer, finally one of the team.`
- Launch sequencing and channel plan move to a sibling doc (`launch-plan.md`) once the tagline is locked.
- Little-hands visual motif for `8gent-hands` shows up in launch visuals. Visual spec is Moira's (8DO). Copy here only names the motif so Moira and Zara align.
