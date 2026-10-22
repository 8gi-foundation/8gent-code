# 8gent on Android (Termux, kali and arch proots)

For a phone running Termux, either in Termux itself or inside a proot distro (kali, arch) started from it. All provider settings are listed in [providers.md](providers.md).

## What applies where

- **Termux proper** (the Termux shell, `PREFIX` under `com.termux`): 8gent loads its `termux-exec` support automatically. The launcher turns it on when the platform is `android` or `PREFIX` contains `/com.termux/` (`bin/termux-exec.js:20-22`).
- **Inside a proot** (kali, arch): this is plain Linux on arm64. The `termux-exec` support stays off, which is correct. Install and update as on any Linux box.
- **Node 22.5 or newer is required** (`bin/node-version.js:3`, `node:sqlite`). Kali's `apt` has shipped Node 20, so check first.
- **You do not need Bun.** When Bun is not installed, 8gent runs its Node build.

## What `8gent update` does

`8gent update` downloads the newest GitHub release tarball, checks it against the release signature, and installs it with `npm install -g <tarball> --ignore-scripts --prefix <your npm prefix>`. If npm fails it retries once with `--force`, then prints the exact command to run by hand. It installs from npm by name only when github.com cannot be reached (`packages/eight/self-update.ts`).

## Kali proot

1. Check what you have:

   ```bash
   command -v 8gent; node -v; npm prefix -g
   ```

2. If `node -v` prints anything below v22.5, install Node 22 from NodeSource (you are root in the proot; add `sudo` if your user is not):

   ```bash
   apt-get update && apt-get install -y curl ca-certificates
   curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh
   bash /tmp/nodesource.sh && apt-get install -y nodejs
   ```

3. If you changed Node in step 2, or `8gent` was not found, install 8gent directly:

   ```bash
   npm install -g @8gi-foundation/8gent-code@0.20.13 --force
   ```

   Otherwise run `8gent update`.

4. Confirm the version: `8gent --version`
5. Start it: `8gent`, then type `/help`.

## Arch proot

1. Check what you have:

   ```bash
   command -v 8gent; node -v; npm prefix -g
   ```

2. If `node -v` prints anything below v22.5, install Node and npm from pacman:

   ```bash
   pacman -Syu --noconfirm nodejs npm
   ```

3. If you changed Node in step 2, or `8gent` was not found, install 8gent directly:

   ```bash
   npm install -g @8gi-foundation/8gent-code@0.20.13 --force
   ```

   Otherwise run `8gent update`.

4. Confirm the version: `8gent --version`
5. Start it: `8gent`, then type `/help`.

## If 8gent exits with no output

If the program 8gent starts is killed by a signal (SIGILL inside a proot is one example), 8gent prints the signal and exits 1. Run `EIGHT_RUNTIME=node 8gent` to skip Bun and use the Node build. Add `export EIGHT_RUNTIME=node` to `~/.bashrc` to keep it.

The pinned version above is the release current on 22 Oct 2026. Newer ones are listed on the [releases page](https://github.com/8gi-foundation/8gent-code/releases); once 8gent is installed, `8gent update` fetches the newest.
