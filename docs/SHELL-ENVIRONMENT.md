# Shell environment for model-run commands

Commands run through `run_command`, `background_start`, the browser-use fallback and the gh helper get a minimal environment, not a copy of the launching shell's.

## What is passed by default

- Shell basics: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `PWD`, `CI`, `NO_COLOR`, `COLORTERM`, `EIGHT_HEADLESS`, and the Windows equivalents (`ComSpec`, `SystemRoot`, `PATHEXT`, `TEMP` and similar).
- Toolchain paths: `VIRTUAL_ENV`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`, `PYTHONPATH`, `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `NODE_ENV`, `NVM_DIR`, `VOLTA_HOME`, `PNPM_HOME`, `BUN_INSTALL`, `the named XDG_ variables`, `DOCKER_HOST`, `KUBECONFIG`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`.
- Proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, either case) (and `DOCKER_HOST`) when the value has no `user:pass@` part.
- Any name ending in `_TOKEN`, `_KEY`, `_SECRET`, `_AUTH`, or containing `PASSW`, `PASSPHRASE`, `CREDENTIAL`, `TOKEN`, `KEY` or `SECRET`, is not passed by default.

## Passing more by name

Export `EIGHT_SHELL_ENV_PASS` in the shell that launches 8gent, listing the names to pass:

```
EIGHT_SHELL_ENV_PASS=NPM_TOKEN,JAVA_HOME 8gent
```

It applies to that session. The keys file cannot set it: any `EIGHT_SHELL_ENV_*` line there is ignored.

## Git and gh

The git tools (`git_push`, `git_commit` and the rest) keep SSH working without any setting. For `git push` over SSH typed through `run_command` or `background_start`, set `EIGHT_SHELL_ENV_PASS=SSH_AUTH_SOCK` in the launching shell.

The gh helper (`gh_pr_create`, `gh_issue_create`, `gh_pr_view`) keeps `GH_TOKEN`, `GITHUB_TOKEN` and `GH_HOST`. A `gh` command typed through `run_command` uses gh's own stored login, or the names you pass.

## When a command fails

The first failed command in a session gets one extra line pointing at `EIGHT_SHELL_ENV_PASS`, if the launching shell had variables that were not passed. It never lists names or values.
