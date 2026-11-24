# Data Preparation

## Source

Obtain the US, OSN (Germany), and VIC (Canada) measurements from the
[StarNet Measurement Dataset](https://github.com/ConnectedSystemsLab/StarNet#starnet-measurement-dataset)
section of the authors' repository. Follow the upstream terms and cite
[*Vivisecting Starlink Throughput: Measurement and Prediction*](https://doi.org/10.1145/3768971).
Keep downloaded and processed measurement inputs local.

## Local Replay Format

Each `.trace` file contains two whitespace-separated columns:

```text
elapsed_time_seconds throughput_mbps
```

Throughput is replayed at one-second granularity by the isolated traffic
shaper. Each browser session downloads 48 four-second chunks using the common
bitrate ladder `[3, 8, 15, 30, 60, 120]` Mbps.

## Local Evaluation Inputs

Prepare 600-second replay windows at 1-second granularity, with
recording-level train/calibration/test splits as described in the paper.

Prepare the local replay files at `<dataset>/<region>/<split>/<trace_id>`.
The selector expects `window_manifest.csv` in `<dataset>` with the columns
`region`, `split`, `trace_id`, `source_recording_id`,
`source_start_timestamp` (ISO 8601), and `window_start_s` (offset in seconds).
From the repository root, select 10 windows per region from your locally
prepared test pool and verify the resulting evaluation manifest:

```bash
python3 tools/select_emulation_traces.py --dataset /path/to/local/windowed-data \
    --split test --per-region 10 --horizon-s 192 \
    --output data/local/evaluation_holdout30.csv
python3 scripts/verify_artifact.py --trace-manifest data/local/evaluation_holdout30.csv
```

The batch and analysis scripts use that output path by default; set
`TRACE_MANIFEST` to use another local manifest.

## External Baseline Inputs

StarNet-MPC and Lumos-MPC require local causal predictor outputs from the
[StarNet](https://github.com/ConnectedSystemsLab/StarNet) and
[Lumos](https://github.com/GreenLv/Lumos) pipelines. WABB requires weather
features derived from the StarNet measurements, mapped to the target-buffer
rule in [the baseline description](BASELINES.md). Prepare these inputs
locally as `app/assets/external_baselines.json`:

- Set `schema` to `1`.
- For each requested predictor, set `predictors.<method>.predictor` to the
  predictor name and `predictors.<method>.traces.<trace_id>` to an ordered
  array of `[elapsed_seconds, predicted_kbps]` rows. Use `starnet_mpc` or
  `lumos_mpc` as the method key.
- For WABB, set `wabb.traces.<trace_id>` to an object containing
  `target_buffer_s` and `weather_class`.

Select methods that do not require these extra inputs with
`METHODS="dashjs robustmpc sara cmab safesabr"` when running the evaluation.
The synthetic smoke test does not need either the evaluation manifest or the
external baseline inputs.
