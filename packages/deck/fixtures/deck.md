---
marp: true
theme: default
paginate: true
---

# Eight System One

## A Local Decision Engine

**`@8gent/decide`** - typed questions, calibrated probabilities.

- Code owns thresholds; backends report probability mass only.
- Three question kinds: `noul`, `choice`, `score`.

---

# The Contract

| Kind    | Input                         | Output                     |
|---------|-------------------------------|----------------------------|
| `noul`  | `prompt`                      | `{ yes }`, confidence      |
| `choice`| `prompt`, `options[]` (2-255) | `probabilities[]`, `chosen` |

```ts
const decide = createDecider();
const a = await decide.noul(state, "Is the build healthy?");
```

---

<!-- _class: lead -->

# Bash Guard

1. **Prompt-control rule** - text addressed to the judge is blocked by rule.
2. **Fenced state** - the command cannot forge its own prompt.

<!-- Speaker note: rules only make verdicts stricter; pass means ask the model. -->
