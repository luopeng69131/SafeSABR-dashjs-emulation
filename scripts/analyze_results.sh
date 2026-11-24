#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

manifest="${TRACE_MANIFEST:-data/local/evaluation_holdout30.csv}"
if [[ ! -f "${manifest}" ]]; then
    echo "Missing local trace manifest: ${manifest}. See docs/DATASET.md." >&2
    exit 1
fi

python3 tools/analyze_emulation_holdout.py \
    --manifest "${manifest}" \
    --results results/paper/raw \
    --output-dir results/paper/analysis \
    --target safesabr_selective_rescue \
    --bootstrap-samples "${BOOTSTRAP_SAMPLES:-20000}"

python3 tools/plot_emulation_holdout.py \
    --analysis-dir results/paper/analysis

echo "[analysis] outputs written to results/paper/analysis"
