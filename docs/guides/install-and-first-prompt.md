# Install and first prompt

This page takes you from nothing to your first answer from 8gent Code. It uses the npm path. It was followed step by step on a clean setup (empty home folder, fresh directory) on 9 and 10 October 2026.

## Before you start: the npm package is behind

The version on npm is **0.17.0**. The project is further along than that, and the new publish token that lets us release to npm has not landed yet (expected 10 October 2026). Until it does:

- `npm install -g @8gi-foundation/8gent-code` still works, but you get 0.17.0.
- In 0.17.0, `8gent --version`, `8gent --help` and `8gent doctor` work, but `8gent run` and `8gent chat` stop with an error about a missing `001-traces.sql` file. If you see that, use the release file in the next section instead.
- The standalone binary command in the README does not work right now, because the newest GitHub release has no files attached.

This page is updated once the npm package catches up.

## What you need

- [Bun](https://bun.sh). The npm install puts the `8gent` command on your path, but it runs on Bun. If Bun is missing, 8gent tells you and prints the one-line install command.
- Node and npm, to run the install.
- A model to talk to. The easiest is [Ollama](https://ollama.com) with a model pulled, for example `ollama pull qwen3.5`. Without any model, 8gent cannot answer.

## Step 1: install

Option A, from npm (gets 0.17.0 for now):

```bash
npm install -g @8gi-foundation/8gent-code
```

Option B, from the release file (recommended until npm catches up). Download the `.tgz` and `SHA256SUMS` from the [v0.18.0 release](https://github.com/8gi-foundation/8gent-code/releases/tag/v0.18.0), then:

```bash
shasum -a 256 8gi-foundation-8gent-code-0.18.0.tgz   # must match the line in SHA256SUMS
npm install -g ./8gi-foundation-8gent-code-0.18.0.tgz
```

The install takes about 30 seconds. You may see yellow `EBADENGINE` or `deprecated` warnings. They are harmless.

## Step 2: check it is there

```bash
8gent --version
8gent doctor
```

`doctor` lists what it found (Ollama and its models, optional tools). Missing optional tools such as an OpenRouter key are marked as optional, not as failures.

## Step 3: ask your first question

Go to any folder and run:

```bash
8gent run "say hello in one sentence"
```

**Be patient on the first run.** If your model is not loaded yet, nothing prints for up to a minute while it loads. That is normal; it is tracked as a known rough edge. The next prompt is fast.

You should see a one-line answer.

## Step 4: let it do something small

```bash
mkdir try-8gent && cd try-8gent
8gent run "create a file hello.txt containing the word hi"
cat hello.txt
```

8gent prints each step it takes (`write_file`, `read_file`) and then a one-line summary. `hello.txt` now exists in your folder and contains `hi`.

## Step 5: the full interface

```bash
8gent
```

This opens the chat screen. Type a request and press Enter. `/provider` lists every model option.

## If something looks wrong

| You see | What it means | What to do |
|---|---|---|
| `8gent requires Bun to run` | Bun is not installed | Run the install line it prints, then open a new terminal |
| `The local model endpoint ... is not reachable` | No model server is running | Start Ollama (or LM Studio), pull a model, try again |
| `ENOENT ... 001-traces.sql` on `run` or `chat` | You installed npm 0.17.0 | Use Option B above |
| `8gent doctor` says Ollama is running but `run` cannot reach it | `doctor` ignores a custom `OLLAMA_HOST` (known bug) | Check the host and port yourself |
| Nothing prints for a minute after `run` | Cold model load | Wait; this is tracked as a known rough edge |
| README binary command gives 404 | Newest release has no files | Use Option B |

To use a hosted model with your own key, run `8gent keys` and add the key to `~/.8gent/keys.env`, then pick it with `/provider`. Nothing is sent to a hosted model unless you add a key.

## Known gaps

These were found while writing this page and are filed on GitHub: the stale npm package and empty latest release (#3340, #3369, #3327), the `run` crash in 0.17.0 (#3778), `doctor` ignoring `OLLAMA_HOST` (#3779), and no message during a cold model load (#3780).
