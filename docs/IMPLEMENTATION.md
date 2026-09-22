# Implementation Overview

## Browser Player

`app/index.html` loads a pinned dash.js 5.2.0 bundle and the ABR modules in
`app/`. `app/app.js` configures a common player profile, registers the selected
quality rule, starts trace replay, and records session metrics. The SafeSABR
policy is exported as a browser-readable neural network in
`app/assets/safesabr_seed42.json`.

## Risk-Aligned Runtime

`app/policy.js` reconstructs the policy state from player observations and
implements pre-request risk correction. `app/flight_rescue_rule.js` observes
in-flight HTTP request progress through dash.js abandonment-rule callbacks. It
estimates the completion time of the active representation, evaluates eligible
lower representations using information available at that checkpoint, and
issues a strong replacement request only when the retain-or-correct rule is
satisfied.

## Network Replay

`shaper/replay_trace.py` applies each trace inside the media container. The
entrypoint checks that it is running in Docker and rejects physical host
interfaces. The configured rate compensates for Linux traffic-control overhead
using the calibration recorded in `config/protocol.yaml`.

## Measurement

`runner/run_browser.py` starts Chrome through Selenium, clears browser cache,
loads the selected method, waits for completion, and stores both application
metrics and Chrome DevTools network records. QoE is computed from executed
bitrates, media-element rebuffering, and bitrate-switching penalties. Wasted
traffic is computed from abandoned media bytes observed on the wire.

## Reproducibility Assets

- `app/assets/safesabr_seed42.json`: trained SafeSABR policy.
- `app/assets/safesabr_risk_critic.json`: pre-request risk estimator.
- `app/assets/external_baselines.json`: causal predictor and weather inputs.
- `app/vendor/dash.all.min.js`: pinned dash.js 5.2.0 bundle.
- `data/manifests/evaluation_holdout30.csv`: fixed evaluation protocol.
- `artifacts/paper/`: compact outputs from the paper run.

Their hashes and structural invariants are checked by
`scripts/verify_artifact.py`.
