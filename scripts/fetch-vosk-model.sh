#!/usr/bin/env bash
# Fetch the small English Vosk model and package it as the .tar.gz that
# vosk-browser expects, into apps/web/public/models/. The model (~40MB) is
# gitignored -- run this locally and in the deploy pipeline. Open-source
# (Apache-2.0), no key, no registration.
set -euo pipefail

MODEL="vosk-model-small-en-us-0.15"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$SCRIPT_DIR/../apps/web/public/models"
DEST="$DEST_DIR/vosk-model-small-en-us.tar.gz"

mkdir -p "$DEST_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $MODEL ..."
curl -fsSL "https://alphacephei.com/vosk/models/$MODEL.zip" -o "$TMP/model.zip"
unzip -q "$TMP/model.zip" -d "$TMP"
echo "Packaging -> $DEST"
tar -czf "$DEST" -C "$TMP" "$MODEL"
echo "Done: $(du -h "$DEST" | cut -f1) at $DEST"
