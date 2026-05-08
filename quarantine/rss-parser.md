# rss-parser

RSS/Atom feed parser that extracts items with title, link, description, date, and author.

## Requirements
- parse(xmlString): returns Feed with { title, link, items[] }
- parseAtom(xmlString): handles Atom format
- parseRSS(xmlString): handles RSS 2.0 format
- normalizeItem(item): maps both formats to unified Item schema
- renderFeed(feed): formatted feed summary

## Status

Quarantine - pending review.

## Location

`packages/tools/rss-parser.ts`
