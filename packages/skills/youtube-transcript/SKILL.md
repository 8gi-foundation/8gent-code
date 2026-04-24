---
name: youtube-transcript
description: Fetch transcripts from YouTube videos without API keys or a browser. Use when the user shares a YouTube URL and wants it summarized, quoted, or analyzed.
trigger: /youtube-transcript
aliases: [/yt, /transcript]
tools: [bash]
examples:
  - /yt https://youtu.be/2d9ZmA-4QzU
  - /transcript <video_id>
  - /youtube-transcript <url> --srt
---

# YouTube Transcript

Pulls captions (manual or auto-generated) from any public YouTube video. No API keys. No browser.

## When to use

- User shares a YouTube link and wants the content summarized, quoted, or analyzed.
- Need source material from a talk or interview before writing a post or doc.
- Dogfooding a tutorial someone linked.

## How it works

Uses the `youtube_transcript_api` CLI (installed via `pipx install youtube-transcript-api`). Calls YouTube's unauthenticated caption endpoint directly, so it works without OAuth, without yt-dlp, and without a headless browser.

## Steps

1. **Extract the 11-char video ID** from whatever URL shape the user sent.
   - `https://youtu.be/XXXXXXXXXXX?si=...` -> path segment
   - `https://www.youtube.com/watch?v=XXXXXXXXXXX` -> `v` query param
   - `https://www.youtube.com/shorts/XXXXXXXXXXX` -> path segment
   - Already-bare 11-char ID -> use as-is
   - Safe extractor: `echo "$URL" | grep -oE '[A-Za-z0-9_-]{11}' | head -1`

2. **Fetch the transcript.** Default to plain text for summarization:
   ```bash
   youtube_transcript_api <VIDEO_ID> --format text
   ```

3. **Present back to the user.** Default: a 3-5 bullet summary plus 1-2 direct quotes. Offer the raw transcript on request. Don't dump the whole thing unsolicited.

## Flags

| Flag | When to use |
|------|-------------|
| `--format text` | Summarization (default). |
| `--format srt` | User wants timestamps for citations. |
| `--format json` | Need structured data for a downstream tool. |
| `--list-transcripts` | Check available languages before fetching. |
| `--languages en es fr` | Priority order of language tracks. |
| `--translate en` | Translate an auto-generated track. |
| `--exclude-generated` | Only manual (human) captions. |

## Fallback chain

1. `youtube_transcript_api <ID> --format text` is the primary.
2. On failure: `--list-transcripts` to see what languages are actually available, retry with those codes.
3. If YouTube is rate-limiting by IP: add `--http-proxy <url>` or swap to `yt-dlp --skip-download --write-auto-subs` as a secondary source. yt-dlp is more fragile; upgrade first (`brew upgrade yt-dlp`) if it errors.
4. No captions at all: tell the user directly. Do not hallucinate content from the title or thumbnail.

## Install check

```bash
which youtube_transcript_api || pipx install youtube-transcript-api
```

## Caveats

- Auto-generated captions contain speech-recognition errors (proper nouns, jargon, branded terms). Normalize obvious ones silently when quoting back.
- Music videos, private/unlisted videos, and videos with captions disabled will return nothing.
- Some live streams only have captions available after the stream ends.

## Principle alignment

- **Free and local by default.** No API keys, no cloud-only service.
- **Reduce friction.** User pastes a URL, we do the rest.
- **Orchestrate.** This skill is a primitive other skills compose with (research agents, content writers, note-takers).
