#!/usr/bin/env bash
set -euo pipefail

# Installs the local engine behind session search by meaning (bot/src/meaning-index.ts):
# llama.cpp's llama-server, built for the CPU at a pinned commit, and Google's EmbeddingGemma
# 300M (Q8_0 GGUF from ggml-org), pinned by revision and SHA-256. Linux only; on a Mac the
# index reports itself unavailable and search matches words only.
#
# Idempotent: each piece is skipped when already present and correct.

if [ "$(uname -s)" != "Linux" ]; then exit 0; fi

LLAMA_REVISION=bd4eeaa047006cb1fe71999fbd11134b5836e167
MODEL_REVISION=0f741b5a6585bd53aeb15cd1372c56f2a0f65e12
MODEL_NAME=embeddinggemma-300M-Q8_0.gguf
MODEL_SHA256=b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63
ROOT=${CONCIERGE_MEANING_ROOT:-/root/.local/share/concierge/meaning}
SOURCE_DIR="$ROOT/llama.cpp"
SERVER="$ROOT/llama-server"
MODEL="$ROOT/models/$MODEL_NAME"
STAMP="$ROOT/llama-server.revision"

mkdir -p "$ROOT/models"

if [ ! -x "$SERVER" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$LLAMA_REVISION" ]; then
  command -v cmake >/dev/null || apt-get install -y --no-install-recommends build-essential cmake git
  if [ ! -d "$SOURCE_DIR/.git" ]; then git clone https://github.com/ggml-org/llama.cpp.git "$SOURCE_DIR"; fi
  git -C "$SOURCE_DIR" fetch --quiet origin "$LLAMA_REVISION" || git -C "$SOURCE_DIR" fetch --quiet origin
  git -C "$SOURCE_DIR" checkout --quiet --detach "$LLAMA_REVISION"
  # Static, so the one binary is the whole engine; CPU only, because the box's Vulkan path
  # failed to embed in the September evaluation.
  cmake -S "$SOURCE_DIR" -B "$SOURCE_DIR/build" -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=ON -DGGML_VULKAN=OFF -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON >/dev/null
  cmake --build "$SOURCE_DIR/build" --target llama-server -j "$(nproc)" >/dev/null
  install -m 0755 "$SOURCE_DIR/build/bin/llama-server" "$SERVER.new"
  mv "$SERVER.new" "$SERVER"
  echo "$LLAMA_REVISION" > "$STAMP"
fi

if [ ! -s "$MODEL" ] || [ "$(sha256sum "$MODEL" | cut -d' ' -f1)" != "$MODEL_SHA256" ]; then
  curl -fsSL -o "$MODEL.part" "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/$MODEL_REVISION/$MODEL_NAME"
  if [ "$(sha256sum "$MODEL.part" | cut -d' ' -f1)" != "$MODEL_SHA256" ]; then
    rm -f "$MODEL.part"; echo "EmbeddingGemma download does not match its pinned SHA-256." >&2; exit 1
  fi
  mv "$MODEL.part" "$MODEL"
fi

echo "meaning engine ready: $SERVER, $MODEL"
