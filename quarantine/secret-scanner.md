# Quarantine: Secret Scanner

## Problem

Secrets (API keys, tokens, passwords, private keys) get accidentally committed to git. Once pushed, they are in the history forever and must be rotated.

## Constraint

Must work as a pre-commit hook with zero config. No external dependencies beyond what already exists in the validation package.

## Not doing

- Git history scanning (use git-secrets or trufflehog for that)
- Auto-rotation of leaked secrets
- Integration with secret managers

## What it does

`packages/validation/secret-scanner.ts` is a CLI-executable scanner that:

1. **Pre-commit mode (default):** Reads git-staged files from the index, scans for secrets using patterns from `secret-patterns.ts`, and exits non-zero if critical/high findings exist. This blocks the commit.
2. **Full scan mode (`--all`):** Recursively scans the entire repo.
3. **File mode (pass file paths):** Scans specific files.

It reuses the existing `security-scanner.ts` and `secret-patterns.ts` - no new pattern definitions, no duplicated logic. The new file is purely the git integration and CLI entry point (~100 lines).

## Patterns detected

All patterns from `packages/validation/secret-patterns.ts`:

- Stripe API keys
- AWS access keys
- Generic API key/secret assignments
- Private key blocks (RSA, EC, DSA, OpenSSH)
- Database connection strings
- JWT tokens
- GitHub personal access tokens
- OpenAI API keys
- Telegram bot tokens
- Basic auth in URLs

## Setup as pre-commit hook

```bash
# Option 1: Direct hook
echo '#!/bin/sh\nbun packages/validation/secret-scanner.ts || exit 1' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# Option 2: Test manually
bun packages/validation/secret-scanner.ts --all
```

## Success metric

Running `bun packages/validation/secret-scanner.ts --all` on the repo should complete without false positives on existing code, and correctly catch test cases with embedded secrets.

## Exit codes

- `0` - no critical/high findings (commit proceeds)
- `1` - critical or high findings detected (commit blocked)
