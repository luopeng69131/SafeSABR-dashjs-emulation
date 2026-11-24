#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
    echo "usage: $0 METHOD TRACE_FILE START_SECOND RESULT_FILE JOB_ID" >&2
    exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${root}"

export METHOD="$1"
export TRACE_FILE="$2"
export TRACE_START_SECOND="$3"
export RESULT_FILE="$4"
export TRACE_ID="$(basename "$2")"
export SESSION_ID="${5}-${METHOD}"
export MEDIA_DIR="${MEDIA_DIR:-${root}/media/formal}"
export PLAYBACK_TIMEOUT_S="${PLAYBACK_TIMEOUT_S:-900}"
project="safesabr-${5//_/-}"
project="${project,,}"

cleanup() {
    docker compose -p "${project}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -p "${project}" up -d --wait --wait-timeout 120 web media chrome
docker compose -p "${project}" run --rm --no-deps runner
