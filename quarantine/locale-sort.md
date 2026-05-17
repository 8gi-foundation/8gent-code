# locale-sort

Locale-aware string sorting with collation order.

## Requirements
- sort(items, locale?, key?) sorts array respecting locale rules
- compare(a, b, locale) returns -1/0/1
- Handles numeric sort: 'file10' after 'file9'
- Ignores diacritics option
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/locale-sort.ts`
