# api-key-scanner

Scans source code strings for leaked API keys and secrets using pattern matching.

## Requirements
- scan(text): returns { found[], clean } where each hit has { type, value, line }
- patterns: AWS, OpenAI, Stripe, GitHub, Slack, Twilio, GCP patterns
- scanFile(content, filename): scans file content with filename context
- redact(text): replaces detected keys with REDACTED placeholders
- renderReport(results): table of detected secrets with severity

## Status

Quarantine - pending review.

## Location

`packages/tools/api-key-scanner.ts`
