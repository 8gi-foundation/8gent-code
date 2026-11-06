# Install

Pick one route. All of them give you the `8gent` command.

## Routes

| Route | Command | Needs |
|---|---|---|
| Standalone binary, macOS and Linux (x64, arm64) | `curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh \| sh` | nothing else |
| Standalone binary, Windows | `irm https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.ps1 \| iex` (PowerShell 5.1 or 7) | no admin rights, no Bun or Node |
| npm | `npm install -g @8gi-foundation/8gent-code` | Node 22.5 or newer (`engines` in `package.json`) |
| From source | `git clone`, then `bun install`, then `bun run tui` | [Bun](https://bun.sh) |

The one-line scripts install the newest published release, not the code on `main`. If no release has a binary for your machine, the script says so and stops with nothing changed. Both scripts check the download against the release `SHA256SUMS` and check the new binary reports the release version before replacing anything. Optional settings: `EIGHT_VERSION`, `EIGHT_INSTALL_DIR`, and on Windows `EIGHT_NO_MODIFY_PATH=1`. To update a binary install, run the same line again. Details: [Install and first run](../user/install.md).

The binary goes to `~/.local/bin` on macOS and Linux (make sure it is on your PATH) and to `%LOCALAPPDATA%\Programs\8gent\bin` on Windows.

## Per platform

- macOS: [../install/macos.md](../install/macos.md)
- Linux: [../install/linux.md](../install/linux.md)
- Windows (including from source and WSL): [../install/windows.md](../install/windows.md), [../user/install.md](../user/install.md)
- Android (Termux, kali and arch proots): [../install/android-termux.md](../install/android-termux.md)
- Every provider and setting: [../install/providers.md](../install/providers.md)

## What the npm launcher does

`bin/8gent-run.js` runs the built CLI with Bun when Bun is on your PATH. If Bun is missing it falls back to the Node build in `dist/node/` (Node 22.5 or newer). If Bun is missing and there is no Node build, it prints the Bun install command for you to run; it does not run it. It also refuses to start inside another 8gent tool shell.

## What install does

- Puts the `8gent` command (also `8` and `8gent-code` for npm installs, per `bin` in `package.json`) on your machine.
- npm only: runs `scripts/postinstall.js`, which prints a welcome line and makes no network requests. On macOS only (and not in CI) it also tries to compile a small bundled helper with `packages/eyes/native/build.sh`; a failure is non-fatal. Set `EIGHT_SKIP_BRIDGE_BUILD=1` to skip it.

## What install does not do

- It does not install system packages by default. The macOS/Linux/Windows routes above do not call a package manager.
- It does not install a model. You bring one (see [First Run](First-Run) and [Providers and Models](Providers-and-Models)).
- It does not send anything to a hosted model. Hosted providers only work after you add a key.

One exception, Termux only: `scripts/install.sh` can run `pkg install` for `nodejs`, and for `proot-distro` when you answer `y` to a prompt (default is no; unattended runs answer no). See [../install/android-termux.md](../install/android-termux.md).

## Check it

```bash
8gent --version
8gent doctor
```

`8gent doctor` checks models and tools and prints the tail of the boot trace. If the screen does not appear, see [Troubleshooting](Troubleshooting).
