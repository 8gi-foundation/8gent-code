# Passport

Your 8gent passport is one file that holds your skills and plugs. You make it, you keep it, and you carry it to a new Mac, PC, Linux box or phone. Nothing is sent anywhere: making and reading a passport never touches the network.

## Make one

```
8gent passport export
8gent passport export --out ~/Desktop/my-passport.tar.gz
```

It saves to `~/.8gent/passport/` unless you pass `--out`, prints the card and ends with "Saved. You hold the only copy." It never overwrites a file that is already there.

What goes in:

- your skills from `~/.8gent/skills/`, `~/.8gent/learned-skills/` and the skills you brought home from other tools;
- your plugs from `~/.8gent/extensions/`.

What stays out: memory and track record (not in this version), and keys and tokens, always. A skill or plug that holds a secrets file (such as `.env`) or anything shaped like a key or token is left out whole, and export tells you which one and why.

## Read the card

```
8gent passport show
8gent passport show ~/Desktop/my-passport.tar.gz --plain
```

The card is 40 columns wide and says "self-issued" on its face: you made it, nobody vouched for it. Every status is a word. `--plain` drops the borders for screen readers; output that is not a terminal never has borders.

## Bring it to a new device

```
8gent passport import ~/Desktop/my-passport.tar.gz
```

Import checks every file against its sha256 first and refuses the whole passport if one does not match. Then it shows a dry run, one line per skill and plug, and asks:

```
Dry run: 5 new, 0 skipped. Apply? [y/N]
```

Only a typed `y` applies it. Enter, a timeout or no terminal at all means no: with no terminal it writes nothing and exits with code 2.

- A skill you already have is never overwritten. It is skipped and reported.
- Plugs never go straight into `~/.8gent/extensions/`. They land in `~/.8gent/quarantine/`, are scanned, and stay off until you promote them: read the files, then move the plug folder into `~/.8gent/extensions/<name>/`.

## Delete

```
8gent passport delete
```

Removes the passport files that export made and lists each one. A file that changed since it was made is left in place and named. Your skills and plugs are not touched.

The file format is open: see [the passport spec](../specs/PASSPORT.md).
