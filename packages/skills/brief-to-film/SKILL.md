---
name: brief-to-film
description: Turn a written brief into a narrated video and post it to a chat. Use when a task says make a film, video or deck from a brief, notes or a markdown file, and send or post it.
trigger: /brief-to-film
tools: [read_file, write_file, render_video_deck, post_message]
---

# Brief to film

Four tool calls, one check after each. Never write ffmpeg, magick or a shell
script for this: `render_video_deck` draws, narrates and joins the slides.

## 1. Read the brief

`read_file` the brief the task names (for example `brief.md`).

Check: you know the audience, the three to eight points the film must make,
and the chat to post to. The chat comes from the task or the brief only. If
neither names a chat, still make the film, then stop at step 4 and say no chat
was given.

## 2. Write deck.json

`write_file` `deck.json` with this shape:

```json
{
  "title": "Short film title",
  "size": "1280x720",
  "slides": [
    { "kicker": "Brief", "title": "One idea per slide", "narration": "One or two plain sentences spoken over this slide." },
    { "title": "What changed", "bullets": ["Point one", "Point two", "Point three"], "narration": "..." }
  ]
}
```

Rules the renderer enforces, so follow them first time:
- 1 to 40 slides. Each slide needs a `title`, `text`, `bullets` or `image`.
- `title` up to 160 characters, `text` up to 600, up to 8 `bullets` of 240,
  `narration` up to 1200. `size` is `1280x720` or `1920x1080`.
- `image` is a png or jpg inside the project, never a URL.
- No other keys: unknown keys are refused.

Check: `read_file deck.json` parses and every point from the brief has a slide.

## 3. Render

`render_video_deck` with `{"spec": <the deck.json object>, "out": "film.mp4"}`.

Check the result, not your plan: `path` ends in `film.mp4`, `durationSec` is
above 0, `slides` equals your slide count, and `hasAudio` is true when any
slide has narration. If it returns an error, fix deck.json from the error text
and render once more. Do not fall back to ffmpeg.

## 4. Post

`post_message` with the chat, `text` as the caption (one or two lines, at most
1024 characters), and `attachment: {"path": "film.mp4", "kind": "video"}`.
The person approves the send. Send once; do not retry after a refusal.

Before calling it, read the NOTE lines `use_skill` printed above this skill.
If one says `post_message` cannot attach a file or is not set up, do not post
the caption on its own. Stop and report, in this form:

```
Film ready: film.mp4 (<durationSec> s, <slides> slides). Not posted: <the reason from the NOTE>.
Caption: <the caption you would have sent>
```

## Done when

The film is posted and `post_message` returned a message id, or the report
above names the film, its length and exactly what was missing.
