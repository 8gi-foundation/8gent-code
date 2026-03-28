# LinkedIn Content Backlog - April 2026

---

## Week 1

### Post 1 - April 1 - P1: AI Agent Development - Positioning Declaration
**Status:** Draft
**Pillar:** P1
**Archetype:** Positioning Declaration

---

Here's what I actually believe about AI agents.

Not the conference version. The real version.

Personal AI is going to replace SaaS the way SaaS replaced desktop software.
Not slowly. Faster than anyone running a SaaS company wants to admit.

The shift isn't "AI features inside your tools."
The shift is: one agent that knows you, your codebase, your preferences, your children's names - and routes every task itself.

That agent doesn't sell your data.
It runs on your machine.
It uses local models by default.
You own the weights. You own the outputs. You own the relationship.

I've been building that agent for the past year.
It's called Eight.
It lives in an open-source repo called 8gent-code.
33 packages. 585+ autonomous PRs. Zero API cost.

The architecture is public. The kernel runs 24/7 on Fly.io Amsterdam.
The source is at 8gent.dev.

I'm not trying to compete with OpenAI.
I'm trying to build what OpenAI won't: a personal AI that belongs to you.

What does "personal AI" mean to you right now - a feature, or a relationship?

---

### Post 2 - April 3 - P2: Autism/Accessibility - Mirror Post
**Status:** Draft
**Pillar:** P2
**Archetype:** Mirror Post

---

You Googled "best AAC app for autism" at 11pm last Tuesday.

You found four options.
Three cost between 200 and 350 euro.
One was free but hadn't been updated since 2019.

The paid ones looked like they were designed by a hospital procurement team in 2011.
Clinical. Grey. Grids of tiny symbols your child has never seen before.

The speech therapist said your child "might benefit from AAC."
She gave you a printout.
The printout had a QR code to a product page.
The product page said "contact us for institutional pricing."

You closed the laptop.

You've been doing this for months.
Every solution is either unaffordable, inaccessible, or designed for the therapist not the child.

And underneath all of it is a question nobody says out loud:
Why does my child's ability to communicate depend on whether I can afford a subscription?

I built 8gent Jr because my son Nicholas needed something that didn't exist.
Pre-verbal. Three years old. Every professional tool priced for institutions, not parents.

It's free. It's live. It works on any phone.
demo.8gentjr.com - try it right now.

No form. No subscription. No "contact us for pricing."

What's been the hardest part of finding communication tools for your child?

---

### Post 3 - April 5 - P3: Solo Founder Journey - Before/After
**Status:** Draft
**Pillar:** P3
**Archetype:** Before/After Transformation

---

278 days.

That's how long the Brazilian court system held my son.

My son Nicholas has autism.
He's pre-verbal - or was. He's starting to say things now.
In March 2023, his mother took him to Brazil and didn't come back.
The Hague Convention on International Child Abduction.
I filed.
I flew.
I waited.

278 days of hearings, delays, appeals, translated documents, legal fees in a currency that wasn't mine.
278 days of WhatsApp calls where I watched my son through a screen and he couldn't tell me what he needed.

I kept building.

Not because building was a solution to any of it.
Because stopping would have meant letting the waiting win.

I shipped the first version of 8gent-code during that period.
I started 8gent Jr because watching Nicholas struggle to communicate through a phone screen made the AAC problem personal in a way no product brief ever could.

He came home.
That was the before and after.

Everything I've built since - the autonomous agents, the free AAC app, the six products across six domains - came from understanding that the circumstances don't stop.
You build inside them.
Or you don't build.

"Difficult crafts masterpieces and symphonies."

I don't say this to inspire you.
I say it because if you're building something real while carrying something heavy, you deserve to know someone else did it too.

What has your hardest period produced?

---

## Week 2

### Post 4 - April 8 - P1: AI Agent Development - System Reveal
**Status:** Draft
**Pillar:** P1
**Archetype:** System Reveal

---

While I slept last Tuesday, my agent opened 23 PRs.

Here's the full system.

The project is 8gent-code. 33 packages. The agent is called Eight.

Step 1: The utility factory.

Eight runs autonomously on a list of planned utilities - rate limiters, semaphores, stream collectors, circuit breakers, health monitors.
Each one is a standalone TypeScript module under 200 lines.
The agent reads the spec, writes the code, writes the tests, opens a PR to a quarantine branch.

Not `main`. Quarantine.

Step 2: The quarantine pattern.

Every autonomous PR lands in `quarantine/[utility-name]`.
It sits there until I review it.
I don't merge anything that hasn't been human-reviewed.
The agent generates. I promote.

This is the key insight: autonomous generation and autonomous promotion are not the same thing.
You want one. You don't want the other. At least not yet.

Step 3: Zero API cost.

The models running this are local.
Ollama. Qwen. Running on my machine, or on the Fly.io vessel.
No per-token billing. No rate limits. No surprise invoices.

585+ PRs generated this way.
Zero dollars spent on inference.

The architecture is open source at 8gent.dev.
The quarantine pattern is documented in the repo.

If you're building an agent-first workflow, what's your promotion criteria?

---

### Post 5 - April 10 - P4: Irish Tech / National AI - Data-Backed Insight
**Status:** Draft
**Pillar:** P4
**Archetype:** Data-Backed Insight

---

Ireland hosts the European headquarters of Google, Meta, Apple, and Microsoft.

We have more Big Tech data centres per capita than almost any country on earth.
We collect the taxes. We process their compliance paperwork.
We do not build what runs inside them.

The 2023 National AI Strategy has 57 actions.
I read all 57.
Action 1 is to "develop a national AI governance framework."
Action 57 is to "monitor implementation."

None of them are: build something.

I contacted the Minister's office about national AI infrastructure earlier this year.
The response was polite.
It referenced the strategy.
It suggested joining the Autism Innovation Strategy advisory group.
Advisory groups advise. They don't ship.

Meanwhile: France has Mistral. UK has DeepMind. US has 14 frontier labs.
Ireland has a governance framework and five years of polite meetings about AI ethics.

The gap isn't capability. Ireland has engineers.
The gap is ownership. We keep renting intelligence from people who own the models.

I'm not saying the government should build Eight.
I'm saying: if a single developer in Dublin can run 5 autonomous AI vessels on Fly.io at zero marginal cost, what could a national effort look like?

What would it take for Ireland to own a piece of its AI future?

---

### Post 6 - April 12 - P2: Autism/Accessibility - Resource Drop
**Status:** Draft
**Pillar:** P2
**Archetype:** Resource Drop

---

I built a free AAC app for kids with autism.

Here's what it actually does.

AAC stands for Augmentative and Alternative Communication.
It's how pre-verbal and minimally-verbal children communicate before or alongside spoken language.
The clinical tools cost 200 to 350 euro.
Most families can't afford them. Most apps are designed for therapists, not children.

8gent Jr is different.

It's designed for a three-year-old.
Large icons. High contrast. Simple grids.
No subscription. No login. No data collection.
Works on any phone. Loads in under two seconds.

It also includes 35+ learning games designed for neurodivergent kids.
Sensory-safe visuals. No time pressure. No "wrong answers" that trigger distress.

The philosophy is parent modeling.

Research shows that when parents use AAC alongside their children - not just handing over the device - children learn to communicate faster.
So the interface is designed for both of them.
Parent and child, side by side.

My son Nicholas went from pre-verbal to starting to talk.
I'm not claiming the app did that.
I'm claiming that having communication tools that didn't cost a fortune meant we could use them every day instead of saving them for therapy sessions.

Try it: demo.8gentjr.com

No form. No email required. No "request a demo."
Just open it and use it.

If you know a family who needs this, send them the link.

---

## Week 3

### Post 7 - April 15 - P1: AI Agent Development - System Reveal
**Status:** Draft
**Pillar:** P1
**Archetype:** System Reveal

---

The quarantine pattern is the most important thing I've built this year.

Not the agent. Not the kernel. The pattern.

Here's how it works.

Every autonomous code generation task targets a quarantine branch, not `main`.
The branch name is `quarantine/[utility-name]`.
The agent writes the code and opens the PR.
The PR sits in review.

Nothing merges without promotion criteria being met.

Promotion criteria for a utility package:
- TypeScript strict mode passes
- Tests exist and pass
- No `eval`, no `require()`, no dynamic imports that bypass the module system
- Exports are explicit and typed
- No side effects on import
- Under 250 lines

If it passes all six, I promote it.
If it fails any one, it goes back.

The agent has generated 585+ PRs this way.
About 60% pass on first review.
The rest go back through one more iteration.

Why does this matter?

Because "autonomous code generation" without a structured review gate is just automated technical debt.
The quarantine pattern separates the speed of generation from the quality of promotion.
You get both.

The full pattern is documented in the 8gent-code repo.
The active quarantine branches are visible on GitHub right now.

What's your review gate for autonomously generated code?

---

### Post 8 - April 17 - P4: Irish Tech / National AI - Contrarian Reframe
**Status:** Draft
**Pillar:** P4
**Archetype:** Contrarian Reframe

---

We keep waiting for OpenAI and Meta to have values they have never shown any sign of having.

This is not a take. It's an observation.

Neither company has demonstrated a consistent commitment to:
- Children's data protection
- Neurodivergent accessibility
- Local-first privacy
- Open model weights that communities can own

And yet, in every policy conversation I've been in, the baseline assumption is:
"We'll use OpenAI's tools, but ask them to be responsible about it."

Asking a company with a $3T market cap to be responsible with your national data infrastructure is not a strategy.
It's a wish.

National AI infrastructure is a public goods problem.
Roads. Water. Broadband.
We don't outsource those to the company with the best PR.

I'm not saying every country needs a frontier lab.
I'm saying: local compute, open weights, and sovereignty over training data are achievable.
France proved this with Mistral.
A 50-person team.

I'm one person.
I'm running 5 autonomous AI vessels on Fly.io from Dublin.
Local models. Zero dependency on any US provider.
It's not perfect. It scales.

The question isn't whether Ireland can build sovereign AI infrastructure.
The question is whether we want to, or whether we're comfortable letting someone else's model know everything about us.

What's your view on who should own the infrastructure intelligence runs on?

---

### Post 9 - April 19 - P3: Solo Founder Journey - Mirror Post
**Status:** Draft
**Pillar:** P3
**Archetype:** Mirror Post

---

It's 11:47pm.

You've shipped one feature today.
One, because the other four hours went to a doctor's appointment you couldn't reschedule, a school call about sensory issues, and 40 minutes of bureaucracy that accomplished nothing.

You have six products.
Not six ideas. Six actual products, with domains, with users, with codebases that need maintenance.

You are the engineer, the designer, the support team, the content person, and the person who remembers to renew the domain before it lapses.

You're also the primary carer for a child who needs more from you than any of this does.

You told yourself you'd post on LinkedIn in January.
It's April.
You still haven't.
Not because you don't have anything to say.
Because saying it requires energy that's already spoken for before 7am.

Nobody is coming to fund this.
Nobody is writing an article about you.
The work is extraordinary and completely invisible.

You ship anyway.
Every day. Whatever's left after everything else.
You ship because stopping would mean admitting the circumstances won.

This is what I know about building under impossible conditions:

The output isn't smaller than what a well-funded team with full days produces.
It's different.
Every feature has been load-tested against the question: "Is this worth the time it costs?"
That filter produces better software.

Difficult crafts masterpieces and symphonies.

What's kept you building on the days when it made no logical sense to?

---

## Week 4

### Post 10 - April 22 - P1: AI Agent Development - What's Actually Working Now
**Status:** Draft
**Pillar:** P1
**Archetype:** What's Actually Working Now

---

5 things I'm seeing in autonomous agents right now. All from production, not theory.

1. Local-first is genuinely viable.

Qwen on Ollama handles 80% of coding tasks that would have required GPT-4 twelve months ago.
Not every task. 80%.
That 80% at zero cost changes the economics of autonomous generation completely.

2. Ability abstraction beats fine-tuning.

Reading an external library, extracting the concept, rebuilding it in under 200 lines works better than trying to include the library.
Less surface area. Fewer dependencies. Better understanding.
The agent that rebuilds is better than the agent that imports.

3. HyperAgents are the right frame.

An agent that only does tasks gets better at tasks.
An agent that studies how it does tasks, identifies failure patterns, and rewrites its own system prompt gets better at getting better.
That's what I mean by meta-improvement.
8gent has had this since v0.4.

4. The kernel/client split matters.

Eight runs as a persistent daemon.
8gent-code, 8gent OS, and 8gent Jr are clients.
The intelligence is central. The interfaces are separate.
This is the only architecture that scales across products without rebuilding the reasoning layer each time.

5. The quarantine pattern is table stakes.

Any autonomous agent shipping code without a structured review gate is accumulating debt faster than it's generating value.
Rate of generation is not the same as rate of quality.
Separate them.

What's working in your agent setup right now?

---

### Post 11 - April 24 - P1: AI Agent Development - Checklist
**Status:** Draft
**Pillar:** P1
**Archetype:** Checklist Post

---

Before your AI agent ships code, run this.

8 checks. Non-negotiable.

1. No `eval`.
Not anywhere. Not wrapped. Not "just for this one case."
If the model outputs eval, the PR fails.

2. No dynamic `require()` or unbounded dynamic imports.
Module resolution needs to be static and auditable.

3. TypeScript strict mode passes.
Not "mostly." Not "except for this one file."
Strict. Or it doesn't merge.

4. Exports are explicit and typed.
No `export *`. Every export is a named, typed contract.

5. No side effects on import.
The module does nothing when you `import` it.
It only does things when you call it.

6. Tests exist and pass.
Not placeholder tests. Tests that cover the actual behavior.
If there are no tests, the PR doesn't exist.

7. Under 250 lines.
If it's longer than 250 lines, it's doing too much.
Split it, or spec it differently.

8. Quarantine before `main`.
Autonomous PRs land in `quarantine/[name]`.
Human review before promotion.
Always.

This is the gate Eight runs every utility through before I consider promoting it.
585+ PRs reviewed against these criteria.
~60% pass on first review.

Save this. Run through it before your next autonomous agent ships code.

Which of these does your current agent skip?

---

### Post 12 - April 26 - P1: AI Agent Development - Start From Scratch
**Status:** Draft
**Pillar:** P1
**Archetype:** Start From Scratch

---

If I had to build an autonomous coding agent from zero today, here's the full architecture.

Starting from what 8gent-code actually is, not what I wish it had been earlier.

Layer 1: The kernel.

A persistent daemon, not a CLI that spins up per request.
It needs to be always-on, session-aware, and capable of resuming from checkpoints.
Fly.io Amsterdam. WebSocket protocol. Agent pool.
Cost: ~3 USD/month.

Layer 2: The ability system.

9 packages, each handling one domain: memory, permissions, orchestration, tools, validation, self-autonomy, evolution, AST indexing, browser.
Each package is standalone. Composable. CLI-callable without the TUI.
Under 200 lines per module where possible.

Layer 3: The quarantine pattern.

Every autonomous code generation target is a quarantine branch.
Never `main` directly.
Promotion criteria are explicit and enforced, not vibes-based.

Layer 4: Local-first models.

Ollama as the default runtime.
Qwen or Mistral depending on task type.
OpenRouter as cloud fallback, not primary.
Zero API cost as the default state.

Layer 5: Memory.

SQLite + FTS5 for episodic and semantic memory.
Facts extracted from conversations, auto-decayed over 30 days.
Relevant memories injected into the system prompt each turn.
The agent that remembers is better than the agent that doesn't.

Layer 6: The TUI.

Ink v6. React for the CLI.
Not a chat box. A full terminal UI with sessions, history, tab-awareness, and activity monitoring.

The one thing I'd do differently:

I'd build the kernel/client split on day one.
I built Eight as a monolith first.
Splitting it into kernel + clients midway cost three weeks and two rearchitectures.

The full source is at 8gent.dev.

What's the first layer you'd prioritize?

---
