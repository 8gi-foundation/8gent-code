#!/bin/sh
# Proves, inside the vessel image, that the sandbox a /selfimprove round uses (linuxSandbox in
# packages/self-autonomy/selfimprove.ts) really isolates model-written code. Run as root in the image:
#
#   docker run --rm --cap-add SYS_ADMIN --security-opt seccomp=unconfined <image> sh /app/scripts/cell-sandbox-proof.sh
#   fly machine run <image> -a <app> --rm -- sh /app/scripts/cell-sandbox-proof.sh      (on Fly, as the cells run)
#
# unshare -n needs CAP_SYS_ADMIN: a Fly machine's root has it, a default Docker container does not (CI adds it).
# Exit 0 only if every check holds. Prints one line per check.
set -u
UID_SB="${CELL_SANDBOX_UID:-1002}"
fail=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; fail=1; }

sb() { unshare -n setpriv --reuid="$UID_SB" --regid="$UID_SB" --clear-groups --no-new-privs -- "$@"; }

[ "$(id -u)" = "0" ] || { echo "FAIL  run this as root"; exit 1; }
unshare -n true 2>/dev/null && ok "unshare -n works (CAP_SYS_ADMIN)" || { echo "FAIL  unshare -n is not allowed here: no CAP_SYS_ADMIN, so no sandbox"; exit 1; }

# Things the cell owns, which the sandbox user must not reach.
mkdir -p /root/.8gent/cell
echo "canary" > /root/.8gent/cell/energy.jsonl
echo "canary-key" > /root/.8gent/cell/key
chmod 600 /root/.8gent/cell/energy.jsonl /root/.8gent/cell/key
chmod 700 /root

# A scratch directory the sandbox user owns, like the one a round makes.
SCRATCH="$(mktemp -d /tmp/cell-scratch-XXXXXX)"
chown -R "$UID_SB:$UID_SB" "$SCRATCH"
chmod 700 "$SCRATCH"

[ "$(sb id -u)" = "$UID_SB" ] && ok "runs as uid $UID_SB" || bad "does not run as uid $UID_SB"
[ "$(sb sh -c 'tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " "')" = "lo" ] && ok "only the loopback device exists" || bad "a network device other than lo is visible"
sb sh -c 'cat /proc/1/environ' >/dev/null 2>&1 && bad "reads /proc/1/environ" || ok "cannot read /proc/1/environ"
sb sh -c 'cat /proc/$PPID/environ' >/dev/null 2>&1 && bad "reads its parent's environment" || ok "cannot read its parent's environment"
sb sh -c 'ls /root' >/dev/null 2>&1 && bad "lists /root" || ok "cannot list /root"
sb sh -c 'cat /root/.8gent/cell/key' >/dev/null 2>&1 && bad "reads the key file" || ok "cannot read the key file"
sb sh -c 'echo x >> /root/.8gent/cell/energy.jsonl' >/dev/null 2>&1 && bad "writes the ledger" || ok "cannot write the ledger"
sb sh -c 'echo x > /app/packages/self-autonomy/selfimprove.ts' >/dev/null 2>&1 && bad "writes the genome" || ok "cannot write the genome"
sb sh -c "echo x > $SCRATCH/f && cat $SCRATCH/f" >/dev/null 2>&1 && ok "writes its own scratch directory" || bad "cannot write its scratch directory"
if command -v bun >/dev/null 2>&1; then
  sb env HOME="$SCRATCH" bun -e 'try { await fetch("https://example.com", { signal: AbortSignal.timeout(4000) }); process.exit(1) } catch { process.exit(0) }' >/dev/null 2>&1 \
    && ok "bun cannot fetch from inside" || bad "bun fetched from inside"
  sb env HOME="$SCRATCH" bun -e 'process.exit(0)' >/dev/null 2>&1 && ok "bun runs as the sandbox user" || bad "bun does not run as the sandbox user"
fi
# The grandchildren inherit all of it.
sb sh -c 'sh -c "ls /root"' >/dev/null 2>&1 && bad "a child lists /root" || ok "a child cannot list /root"

rm -rf "$SCRATCH" /root/.8gent/cell/key /root/.8gent/cell/energy.jsonl
[ "$fail" = "0" ] && echo "sandbox proof: all checks hold" || echo "sandbox proof: FAILED"
exit "$fail"
