#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

if [[ ! -f media/formal/stream.mpd ]]; then
    echo "media/formal/stream.mpd is missing; run scripts/prepare_runtime.sh first" >&2
    exit 1
fi

python3 tools/extract_chunk_sizes.py media/formal app/assets/chunk_sizes.json

public_methods="${METHODS:-dashjs robustmpc sara cmab wabb lumos starnet safesabr}"
internal_methods=()
for method in ${public_methods}; do
    case "${method}" in
        dashjs|dash.js|dash_dynamic) internal_methods+=(dash_dynamic) ;;
        robustmpc|robust_mpc) internal_methods+=(robust_mpc) ;;
        sara) internal_methods+=(sara) ;;
        cmab) internal_methods+=(cmab) ;;
        wabb) internal_methods+=(wabb) ;;
        lumos|lumos_mpc) internal_methods+=(lumos_mpc) ;;
        starnet|starnet_mpc) internal_methods+=(starnet_mpc) ;;
        safesabr|safesabr_selective_rescue) internal_methods+=(safesabr_selective_rescue) ;;
        *) echo "unsupported method name: ${method}" >&2; exit 2 ;;
    esac
done

echo "[run] methods: ${public_methods}"
echo "[run] sessions: 30 per method; workers: ${WORKERS:-1}"
python3 tools/run_batch.py \
    --manifest data/manifests/evaluation_holdout30.csv \
    --methods "${internal_methods[@]}" \
    --workers "${WORKERS:-1}" \
    --results results/paper/raw \
    --logs results/paper/job_logs \
    --buffer-time-default-s 8 \
    --buffer-time-top-s 8 \
    --buffer-time-top-long-s 8 \
    --buffer-to-keep-s 4 \
    --buffer-pruning-interval-s 2

echo "[run] completed; run scripts/analyze_results.sh after SafeSABR is present"
