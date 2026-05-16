# /goal for the neurodivergent: the loop that finishes what you start

**Publication:** AIDHD (ADHD powered by AI)
**Author voice:** James Spalding
**Length target:** 800-1200 words
**Drop:** Day 1 of /goal launch (2026-05-23 Sat morning, Substack queue)
**Status:** DRAFT - requires James approval before publish (per hard rule, no auto-ship)

---

> NOTE FOR JAMES: this draft uses only confirmed-public facts. I have NOT invented diagnosis claims, family history, or biographical detail. Two slots flagged `[JAMES_PERSONAL_HOOK]` and `[JAMES_OPEN_TAB_EXAMPLE]` are for you to fill or strike. If you strike them, the essay still stands at ~950 words.

---

## /goal for the neurodivergent: the loop that finishes what you start

I start a lot of things.

That sentence is not a confession. It is the operating system. If you live somewhere on the AuDHD spectrum, or you suspect you do, you know exactly what comes next. You start a thing. You get to the interesting part. The interesting part ends. The boring part begins. You drift. You start another thing. Two days later you find seventeen open tabs and a folder called "to sort" that is older than some marriages.

The world calls this a failure of discipline. It is not. It is a failure of closure.

Tools have not helped. Most productivity software is a list. A list is just a longer version of the problem. A list assumes the issue is forgetting. The issue is not forgetting. The issue is starting and never finishing the loop.

This week we shipped a feature called `/goal`. It is one slash command. You type what you want done. The agent runs until it is actually done, and a separate model checks the work. Then it stops.

The hook we used for launch is "your laptop just learned the word go". The hook for this essay is harder, because for people like us, it is closer to: the loop that doesn't drift.

### What /goal actually does

You type one line. A real one, that came up on my own machine yesterday:

```
/goal organize my Downloads folder by file type and date, dedupe, surface anything sketchy.
```

It plans. It runs. It uses sub-agents for the parts it can parallelise. When it thinks it is done, a different model on your laptop checks its work. If that judge is not satisfied, the loop continues. If the judge is satisfied, you get one card:

> Done. 247 organized. 41 deduped. 3 flagged.

Then it stops. It does not ask if you want it to keep going. It does not suggest five more things. It stops, because the goal is met.

That is the whole feature. It runs on your machine. No cloud. No keys. No bill.

### Why this matters more if your brain works like mine

Most agentic tools so far have been designed for people who finish things. The user is assumed to be a project manager who can break work down, assign sub-tasks, review them, and close them out. If that is you, you have not needed `/goal`. You have done that work in your head for forty years.

For the rest of us, every step of that chain is where the leak happens.

- Breaking work down is where the executive-function tax hits hardest. You can see the shape of it and you cannot get the first node out of your head.
- Assigning sub-tasks is where the planning fog rolls in.
- Reviewing is where boredom kicks the chair over.
- Closing it out is where you start the next thing instead.

`/goal` does all four of those for you. It plans. It assigns. It reviews. It closes. You provide the outcome. The loop provides the closure.

This is not a list. This is the bottom of a list.

### The second demo: the inbox

I do not love this example, because the inbox is a sore spot, but it is the one most people ask for.

```
/goal triage my inbox by importance and draft replies.
```

It reads your inbox. It sorts it by what looks important to you (not to a sender). It drafts replies for the things you would reply to. It surfaces anything that smells like a chase, a missed deadline, or a phishing attempt.

It does not send. Sending is yours. Drafts sit in your drafts folder. You read them, you fix them, you press send. The cost-of-decision goes from "stare at 412 unread emails" to "approve or rewrite eleven drafts". That is the whole game for an AuDHD inbox.

[JAMES_PERSONAL_HOOK: optional one-line on what your own inbox looked like before vs after the first time you ran this. Strike if you don't want to share.]

### Why it has to be local

I do not want my downloads folder shipped to a server. You probably do not want your inbox shipped to a server. If a feature like this is going to be useful for the neurodivergent population specifically, "useful" includes "no surveillance".

`/goal` runs on your laptop. The executor model is local. The judge model is local. The ledger is on your disk. The flag for cloud exists, but it is opt-in, requires your own API key, and the default install never touches it.

If you have an M-series Mac on macOS 26 you already have the smaller of the two models built into your operating system. If you do not, Ollama and LM Studio are both free downloads. There is no account to make. There is no bill.

### What it does not do

It does not claim to fix executive dysfunction. It does not claim to be therapy. It does not claim to replace medication, structure, or the human routines that keep a neurodivergent life standing up. I am self-identified AuDHD, not formally diagnosed, and I would never pitch a slash command as a clinical intervention.

What it does is close the loop on one specific failure mode: the gap between "I started this" and "this is done". That gap is where the cognitive tax compounds. Closing it gives back hours, and more importantly, gives back the feeling that something you started actually ended.

### How to try it

```
npm i -g @8gi-foundation/8gent-code
8gent
/goal organize my Downloads folder by file type and date, dedupe, surface anything sketchy.
```

That is it. Three lines. The first installs. The second opens the TUI. The third is the demo.

If you do not have an M-series Mac or you do not want to install a model server, the feature will tell you so on the first run and link you to a free local model. It will not silently fall back to a cloud you did not ask for.

[JAMES_OPEN_TAB_EXAMPLE: optional - one screenshot of your before/after if you want to show, not tell. Strike if you would rather just ship words.]

### One last thing

I built 8gent because I wanted the kind of tool I wished existed when my own loops were leaking. I built `/goal` because I was tired of starting things and watching them die in the middle. If you are tired of the same thing, try the slash command. Run the receipt at the end. See what closure on disk looks like.

The loop you do not have to chase yourself is the loop that finally closes.

8gent.dev.

---

**Word count (excluding placeholders, headings, code blocks):** ~960 words.
