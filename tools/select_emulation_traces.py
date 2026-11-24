#!/usr/bin/env python3
"""Select a deterministic, region-balanced split subset without using ABR outcomes."""

from __future__ import annotations

import argparse
import csv
import math
from datetime import datetime, timedelta
from pathlib import Path


def load_throughput(path: Path, horizon_s: float) -> list[float]:
    values = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            fields = line.split()
            if len(fields) >= 2 and float(fields[0]) <= horizon_s:
                values.append(float(fields[1]))
    return values


def difficulty(values: list[float]) -> tuple[float, dict[str, float]]:
    ordered = sorted(values)
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    p10 = ordered[max(0, math.ceil(0.1 * len(ordered)) - 1)]
    drops = [max(values[index - 1] - values[index], 0) for index in range(1, len(values))]
    max_drop = max(drops, default=0)
    low_ratio = sum(value < 30 for value in values) / len(values)
    score = math.sqrt(variance) / max(mean, 1) + max_drop / max(mean, 1) + 2 * low_ratio
    return score, {
        "trace_mean_mbps": mean,
        "trace_p10_mbps": p10,
        "trace_max_drop_mbps": max_drop,
        "trace_low30_ratio": low_ratio,
        "difficulty_score": score,
    }


def select_even_quantiles(rows: list[dict[str, object]], count: int) -> list[dict[str, object]]:
    rows = sorted(rows, key=lambda row: (float(row["difficulty_score"]), str(row["trace_id"])))
    targets = [(index + 0.5) * len(rows) / count - 0.5 for index in range(count)]
    selected = []
    used_recordings = set()
    used_indices = set()
    for target in targets:
        candidates = sorted(
            range(len(rows)),
            key=lambda index: (abs(index - target), index),
        )
        for index in candidates:
            recording = rows[index]["source_recording_id"]
            if index not in used_indices and recording not in used_recordings:
                selected.append(rows[index])
                used_indices.add(index)
                used_recordings.add(recording)
                break
    if len(selected) != count:
        raise RuntimeError(f"could only select {len(selected)} of {count} distinct recordings")
    return sorted(selected, key=lambda row: (str(row["region"]), float(row["difficulty_score"])))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--split", choices=("train", "calib", "test"), default="test")
    parser.add_argument("--per-region", type=int, default=10)
    parser.add_argument("--horizon-s", type=float, default=192)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    manifest_path = args.dataset / "window_manifest.csv"
    candidates: dict[str, list[dict[str, object]]] = {"us": [], "osn": [], "vic": []}
    with manifest_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["split"] != args.split or row["region"] not in candidates:
                continue
            trace_path = args.dataset / row["region"] / args.split / row["trace_id"]
            values = load_throughput(trace_path, args.horizon_s)
            if len(values) < int(args.horizon_s * 0.9):
                continue
            score, stats = difficulty(values)
            started = datetime.fromisoformat(row["source_start_timestamp"]) + timedelta(
                seconds=float(row["window_start_s"])
            )
            candidates[row["region"]].append({
                "region": row["region"],
                "trace_id": row["trace_id"],
                "source_recording_id": row["source_recording_id"],
                "trace_path": str(trace_path.resolve()),
                "start_second_of_minute": started.second + started.microsecond / 1e6,
                **stats,
            })

    selected = []
    for region in ("us", "osn", "vic"):
        selected.extend(select_even_quantiles(candidates[region], args.per_region))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fields = list(selected[0])
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(selected)
    print(f"selected {len(selected)} traces into {args.output}")


if __name__ == "__main__":
    main()
