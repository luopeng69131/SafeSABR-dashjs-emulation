# Starlink Trace Set

## Source

The included network traces are processed from the StarNet measurement
dataset:

- Project: [ConnectedSystemsLab/StarNet](https://github.com/ConnectedSystemsLab/StarNet)
- Paper: *Vivisecting Starlink Throughput: Measurement and Prediction*
- Measurement groups represented here: US, OSN, and VIC

Please cite the StarNet paper when using these traces.

## Trace Format

Each `.trace` file contains two whitespace-separated columns:

```text
elapsed_time_seconds throughput_mbps
```

Throughput is replayed at one-second granularity by the isolated traffic
shaper. Each browser session downloads 48 four-second chunks using the common
bitrate ladder `[3, 8, 15, 30, 60, 120]` Mbps.

## Fixed 30-Session Set

The release includes 30 trace windows: 10 from each region. Within each region,
the test pool was ordered using an outcome-independent difficulty score and
divided into ten strata. The midpoint sample from each stratum was selected.
This preserves a broad range of throughput conditions without using any ABR
method's QoE or rebuffering outcome during selection.

Every selected trace comes from a distinct source recording. The complete
ordering, source recording identifier, starting handover phase, throughput
statistics, and relative path are recorded in
`data/manifests/evaluation_holdout30.csv`.

## Integrity

Run `python3 scripts/verify_artifact.py` to confirm that all 30 traces are
present, paths are relative, recording identifiers are unique, and each region
contributes exactly 10 sessions.
