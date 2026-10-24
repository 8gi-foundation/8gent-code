#!/usr/bin/env bash
# verify-runtime.sh <target> <dir>
# Proves what can be proven about the built programs for one target, and says plainly
# what was not run. Exit 1 on any failed proof.
#   all targets     both files exist, are non-empty, are the right object format and architecture
#   linux-*         statically linked (no dynamic section), and --version / -h run on this machine
#   darwin-arm64    --version / -h run on this machine
#   darwin-x64      lipo says x86_64; run under Rosetta when it is installed, else reported UNPROVEN
#   android-arm64   aarch64 ELF, PIE, interpreter /system/bin/linker64, NEEDED only system libs.
#                   Running it is the smoke-android job (termux-docker), not this script.
set -euo pipefail
target="${1:?usage: verify-runtime.sh <target> <dir>}"
dir="${2:?usage: verify-runtime.sh <target> <dir>}"
ll="$dir/llama-server-$target"
wh="$dir/whisper-cli-$target"
fail() { echo "::error::$*"; exit 1; }
for f in "$ll" "$wh"; do
  [ -s "$f" ] || fail "$f is missing or empty"
done

run_both() {
  v="$("$ll" --version 2>&1)" || fail "$ll --version did not exit 0"
  echo "$v" | head -3
  "$wh" -h >/dev/null 2>&1 || fail "$wh -h did not exit 0"
  echo "ran: llama-server --version, whisper-cli -h"
}

case "$target" in
  linux-x64|linux-arm64)
    want=$([ "$target" = linux-x64 ] && echo "x86-64" || echo "ARM aarch64")
    for f in "$ll" "$wh"; do
      file "$f" | grep -q "$want" || fail "$f is not $want"
      if readelf -d "$f" 2>/dev/null | grep -q NEEDED; then fail "$f is not static"; fi
    done
    run_both ;;
  android-arm64)
    for f in "$ll" "$wh"; do
      file "$f" | grep -q "ARM aarch64" || fail "$f is not an aarch64 ELF"
      readelf -h "$f" | grep -q "DYN" || fail "$f is not PIE"
      readelf -l "$f" | grep -q "/system/bin/linker64" || fail "$f has no Android interpreter"
      needed="$(readelf -d "$f" | sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p' | sort -u | tr '\n' ' ')"
      echo "$f NEEDED: $needed"
      for n in $needed; do
        case "$n" in libc.so|libm.so|libdl.so|liblog.so) ;; *) fail "$f needs $n, not a system library" ;; esac
      done
    done
    echo "UNPROVEN here: execution on Android. See the smoke-android job." ;;
  darwin-arm64)
    for f in "$ll" "$wh"; do lipo -archs "$f" | grep -qx arm64 || fail "$f is not arm64"; done
    run_both ;;
  darwin-x64)
    for f in "$ll" "$wh"; do lipo -archs "$f" | grep -qx x86_64 || fail "$f is not x86_64"; done
    if arch -x86_64 /usr/bin/true 2>/dev/null; then
      v="$(arch -x86_64 "$ll" --version 2>&1)" || fail "$ll --version did not exit 0 under Rosetta"
      echo "$v" | head -3
      arch -x86_64 "$wh" -h >/dev/null 2>&1 || fail "$wh -h did not exit 0 under Rosetta"
      echo "ran under Rosetta: llama-server --version, whisper-cli -h"
    else
      echo "::warning::Rosetta is not installed on this runner: darwin-x64 execution is UNPROVEN (architecture only)"
    fi ;;
  *) fail "unknown target $target" ;;
esac
echo "verify-runtime: $target ok"
