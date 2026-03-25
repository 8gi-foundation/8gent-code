# Quarantine: Hatchet Agent Observability via OpenTelemetry

## Source
- X: @gabe_ruttner (Mar 23, 2026)
- "We just shipped native observability for @hatchet_dev on OpenTelemetry"

## Key Insights
- Native observability for AI agents using OpenTelemetry standard
- Traces show: run_agent -> build_prompt -> model calls with timing
- Built on open standard (OTel) not proprietary format
- Visual timeline of agent execution steps

## Relevance to 8gent
- We have an observability daemon skill (observability-daemon-setup)
- Our capture-all-events.ts hook logs everything but not in OTel format
- OpenTelemetry would make our agent traces compatible with Grafana, Datadog, etc.
- The Hatchet pattern of tracing agent steps is exactly what we need for debugging

## What to Build
1. Add OpenTelemetry trace export to our event bus (packages/daemon/events.ts)
2. Instrument agent loop with spans: thinking, tool_call, stream, etc.
3. Export to local Jaeger or Grafana for visualization
4. Make the debugger app consume OTel traces
