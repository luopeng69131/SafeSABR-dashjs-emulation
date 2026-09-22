#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

python3 scripts/verify_artifact.py

if [[ ! -f media/formal/stream.mpd ]]; then
    echo "[prepare] generating the 192-second DASH media set"
    bash tools/make_dash_media.sh 192 media/formal
else
    echo "[prepare] reusing media/formal/stream.mpd"
    python3 tools/extract_chunk_sizes.py media/formal app/assets/chunk_sizes.json
fi

docker compose build web media runner
python3 scripts/verify_artifact.py --require-media
echo "[prepare] runtime is ready"
