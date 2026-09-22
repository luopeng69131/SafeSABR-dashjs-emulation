# ABR Methods and Implementation Boundaries

All eight methods use the same dash.js playback path, generated video, chunk
sizes, Starlink traces, network shaper, bitrate ladder, and buffer profile.
Only the bitrate-selection and runtime-execution logic changes.

## dash.js Dynamic

This baseline uses the native dynamic ABR path in dash.js 5.2.0, including its
throughput, BOLA, and request-abandonment rules.

Upstream: [DASH Industry Forum/dash.js](https://github.com/Dash-Industry-Forum/dash.js)

## RobustMPC

The browser implementation follows the finite-horizon robust model predictive
control objective introduced in *A Control-Theoretic Approach for Dynamic
Adaptive Video Streaming over HTTP* (ACM SIGCOMM 2015,
[DOI: 10.1145/2785956.2787486](https://doi.org/10.1145/2785956.2787486)). It
uses measured chunk sizes and a robust estimate derived from causal throughput
history.

## SARA

SARA is based on *Robust Live Streaming over LEO Satellite Constellations:
Measurement, Analysis, and Handover-Aware Adaptation* (ACM Multimedia 2024,
[DOI: 10.1145/3664647.3680712](https://doi.org/10.1145/3664647.3680712)).
The implementation retains the synchronized handover-aware adjustment that is
applicable to the shared VOD environment and wraps RobustMPC. The original live
system also controls playback speed and live-edge behavior, which are outside
the fixed-duration action space used here.

## CMAB

CMAB follows the handover-aware contextual multi-armed-bandit rate-selection
method in *Low-Latency Live Video Streaming over a Low-Earth-Orbit Satellite
Network with DASH* (ACM MMSys 2024,
[DOI: 10.1145/3625468.3647616](https://doi.org/10.1145/3625468.3647616)). Its
bitrate action rule is adapted to fixed-duration VOD; live-latency and
playback-speed actions are not part of the common environment.

Upstream artifact:
[clarkzjw/mmsys24-starlink-livestreaming](https://github.com/clarkzjw/mmsys24-starlink-livestreaming)

## StarNet

The StarNet baseline supplies causal StarNet point-throughput predictions to
the common MPC controller. Predictions are taken only from timestamps
available before the current decision.

Source dataset and predictor:
[ConnectedSystemsLab/StarNet](https://github.com/ConnectedSystemsLab/StarNet)

## Lumos

The Lumos baseline supplies causal decision-tree throughput predictions to the
same MPC controller. It follows the prediction-assisted ABR design in *Lumos:
Towards Better Video Streaming QoE Through Accurate Throughput Prediction*
(IEEE INFOCOM 2022,
[DOI: 10.1109/INFOCOM48880.2022.9796948](https://doi.org/10.1109/INFOCOM48880.2022.9796948)).

Upstream: [GreenLv/Lumos](https://github.com/GreenLv/Lumos)

## WABB

WABB follows the weather-aware buffer-based rate adaptation in *Streaming
Media over LEO Satellite Networking: A Measurement-Based Analysis and
Optimization* (ACM TOMM 2025,
[DOI: 10.1145/3694976](https://doi.org/10.1145/3694976)). The browser
implementation maps StarNet weather features to the calibrated target-buffer
rule used in the common playback environment.

## SafeSABR

SafeSABR combines the released behavior-cloned and session-risk-calibrated
policy with Risk-Aligned Runtime. Before a request, a learned risk estimator
selectively corrects unsafe high-rate actions. During transfer, causal request
progress supports counterfactual comparison between retaining the current
representation and restarting at an eligible lower representation. A
session-level severe-risk budget permits correction when it avoids a residual
long stall even if the immediate QoE comparison alone is inconclusive.
