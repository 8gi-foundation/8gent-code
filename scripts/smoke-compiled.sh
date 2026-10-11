#!/usr/bin/env bash
# Smoke-test a compiled 8gent binary (bun build --compile output).
# Source-mode tests cannot see this class of bug: anything read from disk or
# loaded as a native addon at import time works under `bun run` and crashes
# inside the compiled binary. Each check runs the real command in a throwaway HOME.
#
#   scripts/smoke-compiled.sh dist/bin/8gent-darwin-arm64
set -uo pipefail

BIN="${1:?usage: smoke-compiled.sh <path-to-compiled-8gent>}"
[ -x "$BIN" ] || { echo "not executable: $BIN" >&2; exit 2; }
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT
cd "$TMP_HOME" || exit 2

# macOS has no coreutils timeout; perl alarm works on both macOS and Linux.
run() { local secs="$1"; shift; HOME="$TMP_HOME" perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }

fail=0
check() {
	local name="$1" expect="$2" out="$3"
	if printf '%s' "$out" | grep -q -- "$expect"; then
		echo "PASS  $name"
	else
		echo "FAIL  $name"
		printf '%s\n' "$out" | tail -5 | sed 's/^/      /'
		fail=1
	fi
}

check "--version" "8gent Code v" "$(run 20 "$BIN" --version 2>&1)"
check "memory remember" "Remembered" "$(run 30 "$BIN" memory remember "smoke-check-marker" 2>&1)"
check "memory recall" "smoke-check-marker" "$(run 30 "$BIN" memory recall smoke-check 2>&1)"
check "rpc answers JSON-RPC" '"jsonrpc":"2.0"' \
	"$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"__smoke__"}' | run 30 "$BIN" rpc 2>&1)"
check "mcp-server initialize" '"serverInfo"' \
	"$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | run 30 "$BIN" mcp-server 2>&1)"

# The TUI is inside the binary (#2975). Launch `8gent tui` under a real pty with
# no Bun on PATH, a throwaway HOME and a HOSTILE working directory (bunfig.toml
# preload + .env), and require the first frame to render and the preload not to
# run (#3894). Windows has no pty module; windows-smoke.yml covers the .exe via
# scripts/tui-first-frame.mjs (ConPTY), so the Windows bash runner skips here.
case "$(uname -s)" in
	MINGW*|MSYS*|CYGWIN*) echo "SKIP  tui first frame (Windows: see windows-smoke.yml)" ;;
	*)
		if command -v python3 >/dev/null 2>&1 && python3 -c 'import pty, fcntl, termios' 2>/dev/null; then
			HOSTILE="$(mktemp -d)"
			PWNED="$TMP_HOME/PWNED"
			printf 'require("fs").writeFileSync(%s, "x");\n' "\"$PWNED\"" > "$HOSTILE/evil.js"
			printf 'preload = ["./evil.js"]\n' > "$HOSTILE/bunfig.toml"
			printf 'HOSTILE=from-dotenv\n' > "$HOSTILE/.env"
			tui_out="$(HOME="$TMP_HOME" TUI_CWD="$HOSTILE" python3 - "$BIN" <<'PY' 2>&1
import os, pty, re, select, signal, struct, sys, time, fcntl, termios
bin_ = sys.argv[1]
# Allowlist, not a filtered copy of os.environ: nothing else reaches the binary
# (no CI variables either: Ink suppresses rendering under CI, see pack-smoke.ts).
env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.environ["TUI_CWD"])
    os.execve(bin_, [bin_, "tui", "--no-pet"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
buf, deadline = b"", time.time() + 60
first = re.compile(rb"I'm 8gent|8GENT FM")
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        # Answer the terminal-background query (OSC 11) a real terminal would.
        if b"\x1b]11;?" in chunk:
            os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if first.search(buf):
            break
# pty.fork() made the child a session leader: kill its whole process group.
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        break
    time.sleep(0.3)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
text = re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]", b"", buf).decode("utf-8", "replace")
if "TUI entry not found" in text or "Could not start the TUI" in text:
    print("TUI_NOT_STARTED"); print(text[-600:])
elif first.search(buf):
    print("TUI_FIRST_FRAME")
else:
    print("TUI_NO_FRAME"); print(text[-600:])
PY
)"
			check "tui renders first frame (no bun on PATH, hostile cwd)" "TUI_FIRST_FRAME" "$tui_out"
			if [ -e "$PWNED" ]; then echo "FAIL  cwd bunfig.toml preload ran inside the TUI child"; fail=1; else echo "PASS  cwd bunfig.toml and .env were not loaded"; fi
			rm -rf "$HOSTILE"
		else
			echo "FAIL  python3 with the pty module is required for the TUI first-frame check"
			fail=1
		fi
		;;
esac

exit "$fail"
