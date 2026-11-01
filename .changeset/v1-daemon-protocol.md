---
"8gent-code": major
"@8gent/daemon": minor
---

v1.0.0 - Stable daemon with WebSocket protocol for external clients.

The daemon at packages/daemon/ is now the stable entry point for the 8gent ecosystem. External clients (8gent.app, 8gent OS) can connect via WebSocket at localhost:18789, create sessions, send prompts, and receive streamed responses with tool call events. Protocol documented in docs/DAEMON-PROTOCOL.md.

Key changes:
- Fix log append bug (was overwriting on every event)
- Session state persistence on graceful shutdown
- Idle session cleanup (30min timeout)
- Expanded gateway: sessions:list, cron management, health via WebSocket
- DAEMON-PROTOCOL.md specification
- WebSocket connection test script
- Brand alignment (BRAND.md, ecosystem references)
