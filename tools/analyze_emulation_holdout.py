#!/usr/bin/env python3
"""Summarize paired browser-emulation results with session-tail metrics."""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import statistics
from pathlib import Path


DISPLAY_NAMES = {
    "dash_dynamic": "dash.js Dynamic",
    "robust_mpc": "RobustMPC",
    "sara": "SARA",
    "cmab": "CMAB",
    "starnet_mpc": "StarNet",
    "lumos_mpc": "Lumos",
    "wabb": "WABB",
    "safesabr_selective_rescue": "SafeSABR",
}

SUMMARY_METRICS = (
    "qoe",
    "average_bitrate_mbps",
    "total_rebuffer_s",
    "startup_delay_s",
    "smoothness_penalty_mbps",
    "wasted_traffic_ratio",
    "preflight_capped_decisions",
    "rescue_decisions",
)


def mean(values: list[float]) -> float:
    return statistics.fmean(values)


def tail_mean(values: list[float], fraction: float = 0.05) -> tuple[int, float]:
    count = max(1, math.ceil(fraction * len(values)))
    return count, mean(sorted(values, reverse=True)[:count])


def wilson_interval(successes: int, trials: int, z: float = 1.959963984540054) -> tuple[float, float]:
    proportion = successes / trials
    denominator = 1 + z * z / trials
    center = (proportion + z * z / (2 * trials)) / denominator
    radius = (
        z
        * math.sqrt(proportion * (1 - proportion) / trials + z * z / (4 * trials * trials))
        / denominator
    )
    return center - radius, center + radius


def exact_mcnemar_p(improvements: int, regressions: int) -> float:
    discordant = improvements + regressions
    if discordant == 0:
        return 1.0
    lower_tail = sum(
        math.comb(discordant, value) for value in range(min(improvements, regressions) + 1)
    ) / (2**discordant)
    return min(1.0, 2 * lower_tail)


def percentile(sorted_values: list[float], probability: float) -> float:
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = probability * (len(sorted_values) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return sorted_values[lower]
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def load_results(
    manifest_path: Path, results_root: Path
) -> tuple[list[dict[str, str]], dict[str, dict[str, dict[str, float]]]]:
    with manifest_path.open(newline="", encoding="utf-8") as handle:
        manifest = list(csv.DictReader(handle))
    trace_ids = [row["trace_id"] for row in manifest]
    if len(trace_ids) != len(set(trace_ids)):
        raise ValueError("manifest contains duplicate trace_id values")

    methods: dict[str, dict[str, dict[str, float]]] = {}
    for method_dir in sorted(path for path in results_root.iterdir() if path.is_dir()):
        method_results: dict[str, dict[str, float]] = {}
        for trace_id in trace_ids:
            result_path = method_dir / f"{trace_id}.json"
            if not result_path.exists():
                raise FileNotFoundError(f"missing paired result: {result_path}")
            payload = json.loads(result_path.read_text(encoding="utf-8"))
            if payload.get("fatal_error"):
                raise ValueError(f"fatal result in {result_path}: {payload['fatal_error']}")
            metrics = payload["metrics"]
            if metrics.get("completed_chunks") != 48:
                raise ValueError(f"incomplete playback in {result_path}")
            method_results[trace_id] = metrics
        methods[method_dir.name] = method_results
    return manifest, methods


def summarize(
    rows: list[dict[str, str]], methods: dict[str, dict[str, dict[str, float]]]
) -> list[dict[str, object]]:
    trace_ids = [row["trace_id"] for row in rows]
    output: list[dict[str, object]] = []
    for method, method_results in methods.items():
        metrics = [method_results[trace_id] for trace_id in trace_ids]
        rebuffer_values = [float(item["total_rebuffer_s"]) for item in metrics]
        tail_count, worst_tail = tail_mean(rebuffer_values)
        tail_10pct_count, worst_10pct_tail = tail_mean(rebuffer_values, 0.10)
        severe_count = sum(bool(item["severe_session"]) for item in metrics)
        severe_ci_low, severe_ci_high = wilson_interval(severe_count, len(metrics))
        result: dict[str, object] = {
            "method": method,
            "display": DISPLAY_NAMES.get(method, method),
            "sessions": len(metrics),
            "worst_5pct_session_count": tail_count,
            "worst_5pct_rebuffer_s": worst_tail,
            "worst_10pct_session_count": tail_10pct_count,
            "worst_10pct_rebuffer_s": worst_10pct_tail,
            "maximum_rebuffer_s": max(rebuffer_values),
            "severe_session_count": severe_count,
            "severe_session_ratio": severe_count / len(metrics),
            "severe_session_wilson_ci_low": severe_ci_low,
            "severe_session_wilson_ci_high": severe_ci_high,
        }
        for metric in SUMMARY_METRICS:
            result[metric] = mean([float(item.get(metric, 0)) for item in metrics])
        output.append(result)
    return output


def paired_bootstrap(
    trace_ids: list[str],
    strata: dict[str, list[int]],
    target: dict[str, dict[str, float]],
    baseline: dict[str, dict[str, float]],
    samples: int,
    seed: int,
) -> list[dict[str, float | str | int]]:
    rng = random.Random(seed)
    metric_functions = {
        "qoe": lambda values: mean([float(item["qoe"]) for item in values]),
        "average_bitrate_mbps": lambda values: mean(
            [float(item["average_bitrate_mbps"]) for item in values]
        ),
        "total_rebuffer_s": lambda values: mean(
            [float(item["total_rebuffer_s"]) for item in values]
        ),
        "worst_5pct_rebuffer_s": lambda values: tail_mean(
            [float(item["total_rebuffer_s"]) for item in values]
        )[1],
        "severe_session_ratio": lambda values: mean(
            [float(bool(item["severe_session"])) for item in values]
        ),
        "wasted_traffic_ratio": lambda values: mean(
            [float(item["wasted_traffic_ratio"]) for item in values]
        ),
    }
    target_values = [target[trace_id] for trace_id in trace_ids]
    baseline_values = [baseline[trace_id] for trace_id in trace_ids]
    observed = {
        metric: function(target_values) - function(baseline_values)
        for metric, function in metric_functions.items()
    }
    draws = {metric: [] for metric in metric_functions}
    dominance_draws = 0
    for _ in range(samples):
        indices = [
            index
            for stratum_indices in strata.values()
            for index in rng.choices(stratum_indices, k=len(stratum_indices))
        ]
        target_sample = [target_values[index] for index in indices]
        baseline_sample = [baseline_values[index] for index in indices]
        differences = {
            metric: function(target_sample) - function(baseline_sample)
            for metric, function in metric_functions.items()
        }
        for metric, difference in differences.items():
            draws[metric].append(difference)
        if (
            differences["qoe"] >= 0
            and differences["total_rebuffer_s"] <= 0
            and differences["severe_session_ratio"] <= 0
        ):
            dominance_draws += 1

    output: list[dict[str, float | str | int]] = []
    for metric, values in draws.items():
        values.sort()
        output.append(
            {
                "metric": metric,
                "mean_difference": observed[metric],
                "ci_low": percentile(values, 0.025),
                "ci_high": percentile(values, 0.975),
                "paired_sessions": len(trace_ids),
                "bootstrap_samples": samples,
                "joint_qoe_risk_dominance_probability": dominance_draws / samples,
            }
        )
    return output


def paired_counts(
    trace_ids: list[str],
    target: dict[str, dict[str, float]],
    baseline: dict[str, dict[str, float]],
) -> dict[str, int | float]:
    qoe_differences = [float(target[t]["qoe"]) - float(baseline[t]["qoe"]) for t in trace_ids]
    rebuffer_differences = [
        float(target[t]["total_rebuffer_s"]) - float(baseline[t]["total_rebuffer_s"])
        for t in trace_ids
    ]
    severe_improvements = sum(
        bool(baseline[t]["severe_session"]) and not bool(target[t]["severe_session"])
        for t in trace_ids
    )
    severe_regressions = sum(
        bool(target[t]["severe_session"]) and not bool(baseline[t]["severe_session"])
        for t in trace_ids
    )
    tolerance = 1e-9
    return {
        "qoe_wins": sum(value > tolerance for value in qoe_differences),
        "qoe_ties": sum(abs(value) <= tolerance for value in qoe_differences),
        "qoe_losses": sum(value < -tolerance for value in qoe_differences),
        "rebuffer_wins": sum(value < -tolerance for value in rebuffer_differences),
        "rebuffer_ties": sum(abs(value) <= tolerance for value in rebuffer_differences),
        "rebuffer_losses": sum(value > tolerance for value in rebuffer_differences),
        "severe_improvements": severe_improvements,
        "severe_regressions": severe_regressions,
        "severe_ties": len(trace_ids) - severe_improvements - severe_regressions,
        "exact_mcnemar_p": exact_mcnemar_p(severe_improvements, severe_regressions),
    }


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target", default="safesabr_selective_rescue")
    parser.add_argument("--bootstrap-samples", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20260908)
    args = parser.parse_args()

    manifest, methods = load_results(args.manifest, args.results)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(args.output_dir / "summary.csv", summarize(manifest, methods))

    regional_rows: list[dict[str, object]] = []
    for region in sorted({row["region"] for row in manifest}):
        region_manifest = [row for row in manifest if row["region"] == region]
        for row in summarize(region_manifest, methods):
            regional_rows.append({"region": region, **row})
    write_csv(args.output_dir / "summary_by_region.csv", regional_rows)

    session_rows: list[dict[str, object]] = []
    manifest_by_id = {row["trace_id"]: row for row in manifest}
    for method, method_results in methods.items():
        for trace_id, metrics in method_results.items():
            session_rows.append(
                {
                    "method": method,
                    "region": manifest_by_id[trace_id]["region"],
                    "trace_id": trace_id,
                    **{metric: metrics.get(metric, 0) for metric in SUMMARY_METRICS},
                    "severe_session": int(bool(metrics["severe_session"])),
                }
            )
    write_csv(args.output_dir / "sessions.csv", session_rows)

    if args.target not in methods:
        raise ValueError(f"target method is absent: {args.target}")
    trace_ids = [row["trace_id"] for row in manifest]
    trace_region = {row["trace_id"]: row["region"] for row in manifest}
    strata: dict[str, list[int]] = {}
    for index, trace_id in enumerate(trace_ids):
        strata.setdefault(trace_region[trace_id], []).append(index)
    paired_rows: list[dict[str, object]] = []
    paired_count_rows: list[dict[str, object]] = []
    for index, (baseline, baseline_results) in enumerate(methods.items()):
        if baseline == args.target:
            continue
        comparisons = paired_bootstrap(
            trace_ids,
            strata,
            methods[args.target],
            baseline_results,
            args.bootstrap_samples,
            args.seed + index,
        )
        for comparison in comparisons:
            paired_rows.append(
                {"target": args.target, "baseline": baseline, **comparison}
            )
        paired_count_rows.append(
            {
                "target": args.target,
                "baseline": baseline,
                "paired_sessions": len(trace_ids),
                **paired_counts(trace_ids, methods[args.target], baseline_results),
            }
        )
    write_csv(args.output_dir / "paired_bootstrap.csv", paired_rows)
    write_csv(args.output_dir / "paired_counts.csv", paired_count_rows)


if __name__ == "__main__":
    main()
