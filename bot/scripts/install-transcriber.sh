#!/usr/bin/env bash
set -euo pipefail

# Installs the local speech engine that turns retained audio into text.
#
#   Parakeet TDT 0.6B v3 (primary): the resident engine in bot/src/speech-engine.ts. Its model
#     is pinned by revision and SHA-256; its server is built from parakeet-server.cpp against the
#     same pinned whisper.cpp build, which ships libparakeet.
#   whisper.cpp base.en (legacy fallback): used only when Parakeet is missing or fails a
#     request. Scheduled for removal; see Thinkering notes/TODOS.md "Retire whisper.cpp".
#
# Idempotent: each piece is skipped when already present and correct.

WHISPER_REVISION=306c88f4d1286aec1bf96e544632897886af5501
RUNTIME_ROOT=${CONCIERGE_WHISPER_ROOT:-/root/.local/share/concierge}
SOURCE_DIR="$RUNTIME_ROOT/whisper.cpp"
MODEL_DIR="$RUNTIME_ROOT/whisper-models"
BINARY="$SOURCE_DIR/build/bin/whisper-cli"
MODEL="$MODEL_DIR/ggml-base.en.bin"

SPEECH_ROOT="$RUNTIME_ROOT/speech"
PARAKEET_MODEL_NAME=ggml-parakeet-tdt-0.6b-v3-q8_0.bin
PARAKEET_MODEL_REVISION=35156454d1a39de06863303dd209fd2bed6ee079
PARAKEET_MODEL_SHA256=4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e
PARAKEET_MODEL="$SPEECH_ROOT/models/$PARAKEET_MODEL_NAME"
PARAKEET_SERVER="$SPEECH_ROOT/parakeet-server"
PARAKEET_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/parakeet-server.cpp"
if [ ! -f "$PARAKEET_SOURCE" ]; then
  # Run from a source checkout rather than a deploy artifact.
  PARAKEET_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/native/parakeet-server.cpp"
fi

install_whisper() {
  if [ -x "$BINARY" ] && [ -s "$MODEL" ] && command -v ffmpeg >/dev/null && [ -f "$SOURCE_DIR/build/bin/libparakeet.so" ]; then
    return 0
  fi
  apt-get update
  apt-get install -y --no-install-recommends build-essential cmake ffmpeg git curl ca-certificates
  mkdir -p "$RUNTIME_ROOT" "$MODEL_DIR"
  if [ ! -d "$SOURCE_DIR/.git" ]; then
    git clone https://github.com/ggml-org/whisper.cpp.git "$SOURCE_DIR"
  fi
  git -C "$SOURCE_DIR" fetch origin "$WHISPER_REVISION"
  git -C "$SOURCE_DIR" checkout --detach "$WHISPER_REVISION"
  cmake -S "$SOURCE_DIR" -B "$SOURCE_DIR/build" -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=ON
  cmake --build "$SOURCE_DIR/build" --config Release -j "$(nproc)"
  if [ ! -s "$MODEL" ]; then
    "$SOURCE_DIR/models/download-ggml-model.sh" base.en "$MODEL_DIR"
  fi
}

install_parakeet_model() {
  mkdir -p "$SPEECH_ROOT/models"
  if [ -s "$PARAKEET_MODEL" ] && echo "$PARAKEET_MODEL_SHA256  $PARAKEET_MODEL" | sha256sum --check --status; then
    return 0
  fi
  local partial="$PARAKEET_MODEL.partial"
  curl -fsSL --retry 3 -o "$partial" \
    "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/$PARAKEET_MODEL_REVISION/$PARAKEET_MODEL_NAME"
  if ! echo "$PARAKEET_MODEL_SHA256  $partial" | sha256sum --check --status; then
    rm -f "$partial"
    echo "Parakeet model failed its SHA-256 check" >&2
    return 1
  fi
  mv "$partial" "$PARAKEET_MODEL"
}

build_parakeet_server() {
  local stamp="$PARAKEET_SERVER.source-sha256"
  local source_hash
  source_hash="$(sha256sum "$PARAKEET_SOURCE" | cut -d' ' -f1)-$WHISPER_REVISION"
  if [ -x "$PARAKEET_SERVER" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$source_hash" ]; then
    return 0
  fi
  local lib="$SOURCE_DIR/build/bin"
  g++ -O2 -std=c++17 \
    -I"$SOURCE_DIR/include" -I"$SOURCE_DIR/ggml/include" \
    "$PARAKEET_SOURCE" \
    -L"$lib" -lparakeet -lggml -lggml-base -Wl,-rpath,"$lib" \
    -o "$PARAKEET_SERVER.new"
  mv "$PARAKEET_SERVER.new" "$PARAKEET_SERVER"
  echo "$source_hash" > "$stamp"
}

install_whisper
install_parakeet_model
build_parakeet_server

test -x "$BINARY"
test -s "$MODEL"
test -x "$PARAKEET_SERVER"
test -s "$PARAKEET_MODEL"
