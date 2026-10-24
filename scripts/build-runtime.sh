#!/usr/bin/env bash
# build-runtime.sh <target> <outdir>
#
# Builds llama.cpp's llama-server and whisper.cpp's whisper-cli for one release
# target, from the sources pinned in packages/eight/runtime-pins.json. Each source
# tarball is checked against its pinned sha256 before it is unpacked; a mismatch
# stops the build. Output: <outdir>/llama-server-<target> and <outdir>/whisper-cli-<target>.
#
# Targets: android-arm64 linux-x64 linux-arm64 darwin-arm64 darwin-x64.
#   android-arm64  needs ANDROID_NDK_HOME (the NDK on GitHub's ubuntu runners). Bionic libc,
#                  libc++ linked in; the binary needs only the system libc, libm and libdl.
#   linux-*        run inside Alpine (musl), fully static. See .github/workflows/runtime-binaries.yml.
#   darwin-*       Apple clang. darwin-x64 is cross-built on Apple Silicon, without Metal.
# Windows is not built yet.
#
# No network feature is compiled in: LLAMA_OPENSSL=OFF (no HTTPS client, so no -hf model
# download), LLAMA_USE_PREBUILT_UI=OFF (the build fetches nothing but the pinned tarball).
set -euo pipefail

target="${1:?usage: build-runtime.sh <target> <outdir>}"
out="${2:?usage: build-runtime.sh <target> <outdir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
pins="$root/packages/eight/runtime-pins.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
out="$(cd "$out" && pwd)"

sha256_check() { # <sha> <file>
  if command -v sha256sum >/dev/null 2>&1; then echo "$1  $2" | sha256sum -c - >/dev/null
  else echo "$1  $2" | shasum -a 256 -c - >/dev/null; fi
}

fetch() { # <llama|whisper>: download, verify, unpack to $work/<name>
  local name="$1" url sha
  url="$(jq -r ".$name.url" "$pins")"
  sha="$(jq -r ".$name.sha256" "$pins")"
  curl -fsSL --retry 3 -o "$work/$name.tgz" "$url"
  if ! sha256_check "$sha" "$work/$name.tgz"; then
    echo "::error::$name source tarball does not match the pinned sha256 $sha" >&2
    exit 1
  fi
  mkdir "$work/$name"
  tar -xzf "$work/$name.tgz" -C "$work/$name" --strip-components=1
}

jobs="$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) || echo 2 )"

# Flags shared by both programs: static ggml, no OpenMP runtime, no host-specific tuning.
common=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF)
case "$target" in
  linux-x64)
    common+=(-DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DCMAKE_EXE_LINKER_FLAGS=-static) ;;
  linux-arm64)
    common+=(-DCMAKE_EXE_LINKER_FLAGS=-static) ;;
  android-arm64)
    : "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME is not set}"
    common+=(
      "-DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake"
      -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static
      -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod
    ) ;;
  darwin-arm64)
    common+=(-DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON) ;;
  darwin-x64)
    common+=(-DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 -DGGML_METAL=OFF
             -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON) ;;
  *) echo "unknown target: $target" >&2; exit 2 ;;
esac

build() { # <srcdir> <cmake target> <built binary relative path> <asset name> <extra cmake flags...>
  local src="$1" tgt="$2" bin="$3" asset="$4"; shift 4
  cmake -S "$src" -B "$src/build" "${common[@]}" "$@"
  cmake --build "$src/build" --config Release --target "$tgt" -j "$jobs"
  cp "$src/build/$bin" "$out/$asset"
  chmod 755 "$out/$asset"
  # Keep the symbols off: a smaller download. (Apple's strip leaves the signature slot alone.)
  case "$target" in
    android-arm64) "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-strip "$out/$asset" ;;
    darwin-*) strip -x "$out/$asset" ;;
    *) strip "$out/$asset" ;;
  esac
}

fetch llama
build "$work/llama" llama-server bin/llama-server "llama-server-$target" \
  -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_OPENSSL=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_UI=OFF

fetch whisper
build "$work/whisper" whisper-cli bin/whisper-cli "whisper-cli-$target" \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF

ls -l "$out"
