# README snippet for 8gent-code

To be inserted into the project README under the "Quickstart" section above existing content, on launch day 2026-05-22.

---

## /go - autonomous goal-loop (local-first)

Your laptop just learned the word `go`. No cloud. No keys. No bill.

```bash
npm i -g @8gi-foundation/8gent-code
```

Then in the TUI:

```
/go organize my Downloads folder by file type and date, dedupe, surface anything sketchy.
```

The executor and the judge are both local models (Apple Foundation, Ollama, or LM Studio). The loop stops when a separate judge confirms the goal is met. Every run leaves a hash-chained receipt at `~/.8gent/runs/{run-id}/ledger.jsonl`.

Cloud is opt-in only, with your own API key, and the failover never happens silently.

Commands: `/go`, `/go status`, `/go stop`, `/go resume`, `/subgoal`.

[Read the architecture note: Why /go has to be local.](https://8gent.world/posts/why-go-has-to-be-local)
