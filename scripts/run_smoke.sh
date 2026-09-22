#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

echo "[smoke] dash.js Dynamic"
METHOD=dash_dynamic SESSION_ID=smoke-dashjs RESULT_FILE=smoke-dashjs.json \
    bash ./run_smoke.sh

echo "[smoke] SafeSABR"
METHOD=safesabr_selective_rescue SESSION_ID=smoke-safesabr \
    RESULT_FILE=smoke-safesabr.json bash ./run_smoke.sh

if [[ -f media/formal/stream.mpd ]]; then
    python3 tools/extract_chunk_sizes.py media/formal app/assets/chunk_sizes.json
fi

echo "[smoke] both methods completed"
