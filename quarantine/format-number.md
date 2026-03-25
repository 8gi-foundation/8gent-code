# format-number

**Status:** quarantine

## Description

Locale-aware number formatting built on the platform `Intl.NumberFormat` API. No external dependencies. No side effects. Distinct from `number-formatter.ts` which uses manual regex logic - this module delegates to the JS runtime for correct locale behavior across thousands separators, decimal symbols, currency glyphs, and compact notation.

## Exports

| Function | Signature | Example Output |
|----------|-----------|----------------|
| `formatNumber(n, options?)` | unified dispatcher | see below |
| `formatDecimal(n, locale?, decimals?)` | locale separator | `1,234,567` / `1.234.567` |
| `formatCurrency(n, currency, locale?, decimals?)` | currency prefix | `$9.99`, `9,99 €` |
| `formatPercent(n, locale?, decimals?)` | ratio to percent | `75.3%` |
| `formatCompact(n, locale?, decimals?)` | SI compact | `1.2K`, `3.4M`, `1.5T` |
| `formatOrdinal(n)` | ordinal suffix | `1st`, `2nd`, `11th` |
| `formatFileSize(bytes, decimals?)` | binary IEC units | `1.5 MB`, `1.0 GB` |

### `formatNumber` options

```ts
formatNumber(1234567)                                    // "1,234,567"
formatNumber(1234.5, { decimals: 2 })                    // "1,234.50"
formatNumber(0.753, { percent: true })                   // "75.3%"
formatNumber(9.99, { currency: "USD" })                  // "$9.99"
formatNumber(1_200_000, { compact: true })               // "1.2M"
formatNumber(3, { ordinal: true })                       // "3rd"
formatNumber(1_572_864, { fileSize: true })              // "1.5 MB"
formatNumber(1234.5, { locale: "de-DE", decimals: 2 })  // "1.234,50"
```

## Source

`packages/tools/format-number.ts`

## Distinction from number-formatter.ts

| Aspect | `number-formatter.ts` | `format-number.ts` |
|--------|----------------------|-------------------|
| Locale | English-only (regex) | Full Intl support |
| Currency | None | Yes, via Intl |
| Compact | Manual SI thresholds | Intl `notation: "compact"` |
| Percent | Manual multiply | Intl `style: "percent"` |
| File size | Yes | Yes (IEC units) |
| Duration | Yes | No - use number-formatter |

## Integration Path

1. Export from `packages/tools/index.ts` once validated
2. Use in TUI for locale-correct display of user-facing numbers
3. Use in benchmark reporting where locale matters
4. Currency display in any billing/pricing UI
5. Replace manual compact logic in `packages/proactive/` opportunity pipeline

## Validation Checklist

- [ ] Unit tests passing (add in `packages/tools/__tests__/format-number.test.ts`)
- [ ] Exported from `packages/tools/index.ts`
- [ ] Used in at least one production path
- [ ] Edge cases verified: 0, negative, Infinity, NaN, very large numbers
- [ ] Locale roundtrip tested: en-US, de-DE, ja-JP
