#!/usr/bin/env bash
set -euo pipefail

WHISPER_REVISION=306c88f4d1286aec1bf96e544632897886af5501
RUNTIME_ROOT=${CONCIERGE_WHISPER_ROOT:-/root/.local/share/concierge}
SOURCE_DIR="$RUNTIME_ROOT/whisper.cpp"
MODEL_DIR="$RUNTIME_ROOT/whisper-models"
BINARY="$SOURCE_DIR/build/bin/whisper-cli"
MODEL="$MODEL_DIR/ggml-base.en.bin"

if [ -x "$BINARY" ] && [ -s "$MODEL" ] && command -v ffmpeg >/dev/null; then
  exit 0
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

test -x "$BINARY"
test -s "$MODEL"
