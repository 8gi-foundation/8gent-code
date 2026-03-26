# secret-entropy-analyzer

Analyzes strings for high-entropy patterns that indicate secrets, tokens, or keys.

## Requirements
- shannonEntropy(str): returns bits of entropy
- isLikelySecret(str): heuristic combining entropy, length, charset
- scanTokens(text): tokenizes and flags high-entropy tokens
- threshold(context): returns entropy threshold for different contexts (env, url, code)
- renderReport(results): table of suspicious tokens with entropy scores

## Status

Quarantine - pending review.

## Location

`packages/tools/secret-entropy-analyzer.ts`
