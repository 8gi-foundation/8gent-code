# Quarantine: Chat Widget

## What

Embeddable chat widget (`apps/widget/embed.html`) that connects to the Eight daemon via WebSocket. Single HTML file, no build step, drop onto any website with a script tag.

## Status

Quarantined - needs testing against a live daemon instance before promotion.

## How to embed

```html
<script>
  window.EightWidgetConfig = {
    wsUrl: 'wss://eight-vessel.fly.dev',
    authToken: 'YOUR_TOKEN',  // omit if daemon has no auth
    channel: 'widget',
    greeting: 'Hey - I am Eight. How can I help?',
  };
</script>
<script src="https://your-cdn.com/embed.html"></script>
```

Or inline the full HTML in an iframe.

## Features

- Floating bubble (bottom-right), click to expand chat window
- WebSocket connection to Eight daemon gateway (Daemon Protocol v1.0)
- Auth handshake, session creation, prompt/response cycle
- Streaming response display via `agent:stream` events
- Typing indicator during `agent:thinking`
- Auto-reconnect with exponential backoff (1s to 30s)
- Keepalive ping every 30s
- 8gent dark theme with brand colors
- Responsive (max-width adapts to viewport)
- Keyboard: Enter to send, Shift+Enter for newline

## Protocol messages used

- Outbound: `auth`, `session:create`, `prompt`, `ping`
- Inbound: `auth:ok`, `auth:fail`, `session:created`, `event` (wrapping `agent:thinking`, `agent:stream`, `session:end`, `agent:error`, `tool:start`), `error`, `pong`

## What needs validation

1. Live WebSocket connection to eight-vessel.fly.dev
2. Auth token flow (if daemon requires auth)
3. Streaming chunk rendering with real agent output
4. Mobile touch behavior in embedded context
5. CORS / CSP compatibility on third-party sites
6. iframe embedding path

## Files

- `apps/widget/embed.html` - the widget (~200 lines)
- `quarantine/chat-widget.md` - this file
