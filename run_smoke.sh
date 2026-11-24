#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${root}"

smoke_media="${root}/media/smoke"
if [[ ! -f "${smoke_media}/stream.mpd" ]]; then
    tools/make_dash_media.sh 24 "${smoke_media}"
fi

python3 tools/extract_chunk_sizes.py "${smoke_media}" app/assets/chunk_sizes.json

export MEDIA_DIR="${smoke_media}"
generated_profile=""
if [[ -z "${TRACE_FILE:-}" ]]; then
    generated_profile="$(mktemp --suffix=.trace)"
    # Synthetic network profile for the smoke test; no measurement data needed.
    printf '%s\n' '0 80' '4 80' '8 18' '12 12' '16 65' '20 95' '24 25' \
        '28 80' '32 80' '60 80' > "${generated_profile}"
    chmod a+r "${generated_profile}"
    export TRACE_FILE="${generated_profile}"
fi
export METHOD="${METHOD:-dash_dynamic}"
export SESSION_ID="${SESSION_ID:-smoke-${METHOD}}"
export RESULT_FILE="${RESULT_FILE:-${SESSION_ID}.json}"
export PLAYBACK_TIMEOUT_S="${PLAYBACK_TIMEOUT_S:-90}"

cleanup() {
    docker compose down --remove-orphans >/dev/null 2>&1 || true
    if [[ -n "${generated_profile}" ]]; then
        rm -f -- "${generated_profile}"
    fi
}
trap cleanup EXIT

docker compose build web media runner
docker compose up -d web media chrome
docker compose run --rm runner

python3 - "results/${RESULT_FILE}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
result = json.loads(path.read_text())
print(json.dumps(result.get("metrics", result), indent=2, sort_keys=True))
PY
