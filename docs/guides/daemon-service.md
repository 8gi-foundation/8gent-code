# Running the daemon as a login service

The daemon can run in the foreground or as a per-user service that starts when you log in and restarts if it crashes. None of the commands need admin rights.

```bash
8gent daemon run        # foreground, Ctrl+C to stop
8gent daemon install    # install and start the login service
8gent daemon status     # installed? running?
8gent daemon stop
8gent daemon start
8gent daemon uninstall  # stop and remove the service
```

`install` and `uninstall` are safe to repeat. Running `install` again rewrites the service definition and restarts the daemon, which is how you pick up a new `bun` or 8gent path. Running `uninstall` when nothing is installed succeeds.

The service runs the same `8gent` you ran `install` with (a checkout, the npm package, or the compiled binary). Output goes to `~/.8gent/daemon.log`. The health check is `http://localhost:18789/health`.

## Per platform

| Platform | Mechanism | Definition |
|----------|-----------|------------|
| macOS | launchd agent (`bootstrap`, `bootout`, `kickstart`) | `~/Library/LaunchAgents/com.8gent.daemon.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/com.8gent.daemon.service` |
| Windows | Scheduled Task `com.8gent.daemon`, at logon, current user | Task Scheduler library |

On Linux, `install` also runs `loginctl enable-linger` so the daemon keeps running after you log out. If your distribution does not let users enable linger for themselves, `install` prints the `sudo` command to run once.

Where systemd user services are not available (WSL1, most containers), `install`, `start`, `stop` and `status` say so and point you at `8gent daemon run`. Run it under your own supervisor there.

On Windows the daemon's errors go to the same `daemon.log`, as Task Scheduler has no separate error stream.
