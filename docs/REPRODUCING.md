# Reproducing the Browser Experiment

## Execution Path

Each experiment creates an isolated Docker Compose project containing:

1. an Nginx server hosting the player and pinned dash.js asset;
2. a second Nginx server hosting DASH media behind a trace-driven Linux
   traffic shaper;
3. a Selenium Chromium instance; and
4. a Python runner that records playback, request, and runtime decisions.

The browser and runner communicate through a control-only network. Media bytes
traverse a separate internal network whose server-side interface is shaped from
the selected Starlink trace. No service uses host networking.

## Frozen Configuration

- dash.js: 5.2.0
- Chromium container: Selenium 4.35.0
- Video duration: 192 seconds
- Segment duration: 4 seconds
- Representations: 3, 8, 15, 30, 60, and 120 Mbps
- Player target buffer: 8 seconds
- Base round-trip time: 40 ms
- Sessions per method: 30
- Severe-session threshold: 10 seconds cumulative rebuffering

The full machine-readable configuration is in `config/protocol.yaml`.

## Commands

Prepare media and containers:

```bash
bash scripts/prepare_runtime.sh
```

Run the complete evaluation:

```bash
bash scripts/run_paper_experiment.sh
```

The public entry point runs one isolated browser session at a time by default.
On a machine with sufficient CPU and memory, enable parallel execution
explicitly, for example:

```bash
WORKERS=5 bash scripts/run_paper_experiment.sh
```

Raw JSON outputs are stored as
`results/paper/raw/<method>/<trace_id>.json`. Logs are stored under
`results/paper/job_logs`. The batch runner validates existing result files and
therefore resumes incomplete evaluations automatically.

Generate aggregate outputs:

```bash
python3 -m pip install -r requirements-analysis.txt
bash scripts/analyze_results.sh
```

The analyzer computes per-method averages, regional summaries, session-level
tail metrics, paired counts, and stratified paired bootstrap intervals. The
plotter regenerates the QoE-risk operating points and rebuffering survival
curves.

## Comparing with the Paper Snapshot

Reference outputs are in `artifacts/paper`. The expected method count is eight,
with 30 complete sessions per method. The paper reports the point estimates in
the root README. Small timing differences can arise from host scheduling,
container startup, and browser execution; method ordering and the reported
QoE-risk relationships should remain consistent on a stable host.

## Troubleshooting

- Verify Docker Compose with `docker compose version`.
- Keep the default `WORKERS=1` when memory or CPU resources are limited.
- Re-run the same batch command after an interruption; completed results are
  retained.
- Inspect `results/paper/job_logs` for a failed session.
- Rebuild generated media by removing `media/formal` and rerunning
  `scripts/prepare_runtime.sh`.
