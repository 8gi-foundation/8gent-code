# Self-hosted search endpoint

`EIGHT_SEARCH_URL` points `web_search` at a SearXNG-style JSON endpoint (`?q=...&format=json`), so queries stay on a host you run. Unset, `web_search` uses DuckDuckGo.

```bash
export EIGHT_SEARCH_URL=http://127.0.0.1:8888/search
8gent doctor   # prints "Search endpoint http://127.0.0.1:8888 reachable"
```

- Point it only at a host you control. That one origin (scheme, host, port) is exempt from the private-address guard, for search only. `web_fetch` still refuses it.
- Set it in your shell profile or the shell that starts 8gent. A value declared in any `.env` file is ignored, so a cloned project cannot redirect your searches. `8gent doctor` and the first search of a session say so when that happens, and that search goes to DuckDuckGo.
- `bun --env-file=...` is honoured: only the operator can pass that flag, and it supplies the real process environment rather than a file the project ships.
- A configured endpoint that is down returns an error. It never falls back to DuckDuckGo.
- Each search appends its destination origin (the configured origin or `duckduckgo`, never the query) to `~/.8gent/search-origins.jsonl`. `8gent doctor` summarises the recent ones.
