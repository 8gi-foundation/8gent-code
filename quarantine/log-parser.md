# log-parser

Structured log parser supporting JSON logs, Apache/Nginx common log format, and syslog.

## Requirements
- parseJSON(line): parses JSON log line into LogEntry
- parseCommonLog(line): parses Apache/Nginx combined log format
- parseSyslog(line): parses RFC 5424 syslog format
- parseAuto(line): detects format and dispatches to correct parser
- filter(entries[], { level?, status?, after?, before? }): filters log entries

## Status

Quarantine - pending review.

## Location

`packages/tools/log-parser.ts`
