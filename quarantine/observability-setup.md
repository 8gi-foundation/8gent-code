# observability-setup

Observability bootstrapper that generates logging, metrics, and tracing config for a service.

## Requirements
- configure({ service, environment, logLevel, metricsPort, tracingEndpoint })
- loggerConfig(config): structured logging configuration
- metricsConfig(config): Prometheus-compatible metrics setup
- tracingConfig(config): OpenTelemetry tracer setup
- renderSetup(config): complete observability setup as code snippets

## Status

Quarantine - pending review.

## Location

`packages/tools/observability-setup.ts`
