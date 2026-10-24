# Security review and second read: checklist

Used by the Security Officer (8SO) on every review and by whoever does the independent second read on a permissions or security PR. Answer each line in the review, with the file and line when the answer is a finding.

1. **Does any default send user data off the device?** Audio, prompt text, tool results, files, images, keys, usage. Read `docs/security/off-device-data.md`, run `bun scripts/local-first-gate.ts` and `bun scripts/local-first-gate.ts --no-waivers`, and read the diff for a new host, a new provider, a new tool that makes a request, a model chosen automatically from a list, or a first-run question that offers one. A default that sends data is a block, unless it is a dated, linked known item in `scripts/local-first-sinks.ts`.
2. **Does any default run, or tell the person to run, a system install?** pkg, apt, brew, pip install, npm i -g other than 8gent, ollama pull or serve, a cmake or make build. Core works after one install. An install is allowed only behind an explicit opt-in or as a fallback after the person asked for a feature that needs it, marked `local-first-gate: optin` or `fallback` in the code. See `docs/security/principles-gate.md`.
3. Does anything ship unvalidated input to shell execution?
4. Does anything store a secret in plaintext, or print one?
5. Does anything expose personal data without an audit log?
6. Does it touch a child's data (COPPA) or a person in the EU (GDPR) in a way the data map does not cover?
7. Is there a read, write or network boundary this change widens, and is the widened case tested at the real entry point?

Line 1 exists because 8gent v0.20.26 asked a person on a phone to turn on voice input through a speech service that can be Google's cloud. Nothing checked it. The gate checks the part a program can; this line is the part it cannot (a host built from pieces, a URL in an environment variable, a dependency).
