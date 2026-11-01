#!/usr/bin/env bash
# package-linux.sh - Build Linux artifacts for 8gent Code.
#
# For each requested arch, produces:
#   dist/installers/8gent_<version>_<arch>.deb
#   dist/installers/8gent-<version>.<rpmarch>.rpm
#   dist/installers/8gent-<version>-linux-<arch>.tar.gz
#
# Assumes the compiled binaries already exist in dist/bin (produced by
# `bun run scripts/build-binaries.ts`). Requires `nfpm` on PATH for the
# .deb/.rpm; the .tar.gz needs only coreutils + tar.
#
# GPG signing is opt-in and skip-if-absent: if EIGHT_GPG_KEY_ID is set, the
# .deb and .rpm are signed via nfpm's native signing. Never fabricates a key.
# See SIGNING.md.
#
# Usage:
#   scripts/package-linux.sh              # amd64 + arm64 (whatever binaries exist)
#   scripts/package-linux.sh amd64        # single arch
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || bun -e "console.log(require('./package.json').version)")"
OUT="$ROOT/dist/installers"
mkdir -p "$OUT"

# arch name -> bun binary. Kept as a case (portable to bash 3.2 on macOS).
bin_for_arch() {
  case "$1" in
    amd64) echo "dist/bin/8gent-linux-x64" ;;
    arm64) echo "dist/bin/8gent-linux-arm64" ;;
    *) echo "" ;;
  esac
}

ARCHES=("$@")
if [ ${#ARCHES[@]} -eq 0 ]; then
  ARCHES=(amd64 arm64)
fi

have_nfpm=1
command -v nfpm >/dev/null 2>&1 || have_nfpm=0
if [ "$have_nfpm" -eq 0 ]; then
  echo "warning: nfpm not found - will build .tar.gz only. Install nfpm for .deb/.rpm:"
  echo "  go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest"
fi

for arch in "${ARCHES[@]}"; do
  bin="$(bin_for_arch "$arch")"
  if [ -z "$bin" ]; then echo "unknown arch: $arch" >&2; exit 1; fi
  if [ ! -f "$bin" ]; then
    echo "missing $bin - run: bun run scripts/build-binaries.ts --only=bun-linux-${arch/amd64/x64}" >&2
    exit 1
  fi
  echo "== $arch ($bin) =="

  # tar.gz: binary as bin/8gent plus a LICENSE, always buildable.
  staging="$(mktemp -d)"
  mkdir -p "$staging/8gent-$VERSION-linux-$arch/bin"
  cp "$bin" "$staging/8gent-$VERSION-linux-$arch/bin/8gent"
  chmod 0755 "$staging/8gent-$VERSION-linux-$arch/bin/8gent"
  cp LICENSE "$staging/8gent-$VERSION-linux-$arch/LICENSE"
  tar -C "$staging" -czf "$OUT/8gent-$VERSION-linux-$arch.tar.gz" "8gent-$VERSION-linux-$arch"
  rm -rf "$staging"
  echo "  tar.gz -> dist/installers/8gent-$VERSION-linux-$arch.tar.gz"

  if [ "$have_nfpm" -eq 1 ]; then
    # nfpm does not expand env vars in contents[].src, so stage the arch
    # binary to the fixed path the config references.
    cp "$bin" packaging/linux/staged-8gent
    chmod 0755 packaging/linux/staged-8gent
    export EIGHT_VERSION="$VERSION" EIGHT_ARCH="$arch"
    sign_args=()
    if [ -n "${EIGHT_GPG_KEY_ID:-}" ]; then
      echo "  signing packages with GPG key ${EIGHT_GPG_KEY_ID}"
      # nfpm reads deb.signature.key_file / rpm.signature.key_file from env
      # overrides; here we rely on the packager's exported GPG config.
      export NFPM_DEB_SIGNER_KEY_FILE="${EIGHT_GPG_KEY_FILE:-}"
      export NFPM_RPM_SIGNER_KEY_FILE="${EIGHT_GPG_KEY_FILE:-}"
    else
      echo "  (unsigned - set EIGHT_GPG_KEY_ID + EIGHT_GPG_KEY_FILE to sign; see SIGNING.md)"
    fi
    nfpm package -f packaging/linux/nfpm.yaml -p deb -t "$OUT/"
    nfpm package -f packaging/linux/nfpm.yaml -p rpm -t "$OUT/"
    rm -f packaging/linux/staged-8gent
    echo "  deb + rpm -> dist/installers/"
  fi
done

echo "Done. Artifacts in dist/installers/"
ls -1 "$OUT"
