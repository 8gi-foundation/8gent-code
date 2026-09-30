# Turning colour off (NO_COLOR)

8gent Code follows the [NO_COLOR](https://no-color.org) convention. Set it and the whole interface draws without colour:

```bash
NO_COLOR=1 8gent
```

## What you will see

- No colour anywhere: header, footer, tabs, cards and chat.
- Bold, dim and inverse stay, because they are not colour. The text cursor is drawn in inverse, so you can still see where you are typing.
- Permission modes still read without colour: the footer names the mode, Infinite is bold, and tabs carry the mode's name or a letter (`P`, `G`, `∞`).

## Which setting wins

The first match decides:

1. `FORCE_COLOR` set: `FORCE_COLOR=0` turns colour off, `1` to `3` turns it on, even over `NO_COLOR`.
2. `NO_COLOR` set to anything non-empty: colour off.
3. `TERM=dumb`: colour off.
4. Otherwise 8gent follows what your terminal supports.

## Turn it back on

Unset `NO_COLOR`, or set `FORCE_COLOR=1`.
