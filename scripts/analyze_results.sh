#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

python3 tools/analyze_emulation_holdout.py \
    --manifest data/manifests/evaluation_holdout30.csv \
    --results results/paper/raw \
    --output-dir results/paper/analysis \
    --target safesabr_selective_rescue \
    --bootstrap-samples "${BOOTSTRAP_SAMPLES:-20000}"

python3 tools/plot_emulation_holdout.py \
    --analysis-dir results/paper/analysis

echo "[analysis] outputs written to results/paper/analysis"
