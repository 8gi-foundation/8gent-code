# iban-validate

Validate IBAN bank account numbers.

## Requirements
- validate(iban) returns {ok, reason?}
- normalize(iban) removes spaces, uppercases
- extractCountry(iban) returns 2-letter country code
- mod97(iban) performs IBAN checksum
- Supports all EU country formats

## Status

Quarantine - pending review.

## Location

`packages/tools/iban-validate.ts`
