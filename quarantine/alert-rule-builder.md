# alert-rule-builder

Alert rule builder with threshold conditions, silence windows, and severity levels.

## Requirements
- defineRule({ name, metric, condition, threshold, severity, silenceMinutes? })
- evaluate(rule, value): returns { firing, severity, message }
- isSilenced(rule, now): checks silence window
- evaluateAll(rules[], metrics{}): batch evaluation
- renderRules(rules[]): markdown alert rule documentation

## Status

Quarantine - pending review.

## Location

`packages/tools/alert-rule-builder.ts`
