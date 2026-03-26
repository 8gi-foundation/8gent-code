# message-format

ICU MessageFormat-style string interpolation with plurals and selects.

## Requirements
- format(template, args) interpolates {name} placeholders
- Plural: {count, plural, one{item} other{items}}
- Select: {gender, select, male{he} female{she} other{they}}
- Nested placeholders
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/message-format.ts`
