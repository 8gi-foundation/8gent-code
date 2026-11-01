---
name: retro
description: Socratic retrospective over the session that just happened. Finds the friction worth making deterministic, and adopts at most one change. Use at the end of a working session, after a long or messy task, or when the same correction has come up more than once.
trigger: /retro
aliases: [/retrospective, /post-mortem]
tools: [bash, read, write]
---

# Retro

A retro is not a summary. A summary tells the user what they just watched. A
retro finds the thing that cost a decision today and will cost it again
tomorrow, and removes it.

The output is a table of friction, and at most one adopted change.

## Interview first

Ask about THIS session, one question at a time, three to six of them. Keep each
one short. Wait for the answer before asking the next, because the second
question should depend on the first answer.

- Where did you correct me more than once for the same class of mistake?
- What did I work out from scratch that was already written down somewhere?
- Which interruption today did not change what you did next?
- What decision did you make today that you have made before?
- Where did I say something was done? Was every one of those claims backed by
  evidence you could see?

If nobody is there to answer, interview the transcript instead. Answer the same
questions from what actually happened, and cite the moment you are referring to.
An honest "this did not come up" beats an invented finding.

## Then the determinism table

| Friction observed | Recurrence | Fix type | Where it lands |
|---|---|---|---|
| | first time / repeated / chronic | hook / command / skill or memory / decision record | file path or issue |

The fix type is the whole point, so sort it deliberately:

- **Hook** for something that must happen every time, with no judgement. A hook
  is a standing order.
- **Command** for a ritual a person chooses to run, which should then be the
  same every time.
- **Skill or memory** for advice. Advice is the right tier for anything that
  depends on context.
- **Decision record** for anything that changes how the team works rather than
  how the tool works.

The sorting question is: is this a standing order, or a suggestion? If it is a
suggestion, it does not get a hook.

## The cap

**Adopt at most one deterministic change per retro.** File everything else as an
issue or a note so the backlog survives, and say where it went.

The cap is the feature, not a limitation. A retro generates appetite faster than
a codebase can absorb it, and ten adopted changes means ten untested behaviours
landing at once. One change, actually finished, beats a list.

## Finish with one line

Say what got adopted and what got filed. If nothing was worth adopting, say
that. A retro that adopts nothing is a valid retro; a retro that invents
something to adopt is not.
