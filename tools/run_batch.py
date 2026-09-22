#!/usr/bin/env python3
"""Run isolated browser-emulation jobs serially or concurrently with resume support."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


DEFAULT_METHODS = (
    "dash_dynamic",
    "robust_mpc",
    "sara",
    "cmab",
    "starnet_mpc",
    "lumos_mpc",
    "wabb",
    "safesabr_selective_rescue",
)


def valid_result(path: Path) -> bool:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return not result.get("fatal_error") and result.get("metrics", {}).get("completed_chunks", 0) > 0
    except (OSError, ValueError):
        return False


def job_id(method: str, trace_id: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", f"{method}-{trace_id}".lower()).strip("-")
    return value[:55]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--methods", nargs="+", default=DEFAULT_METHODS)
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="number of isolated browser sessions to run concurrently (default: 1)",
    )
    parser.add_argument("--policy-asset", default="safesabr_seed42.json")
    parser.add_argument("--risk-threshold", type=float)
    parser.add_argument("--results", type=Path, default=Path("results/formal/raw"))
    parser.add_argument("--logs", type=Path, default=Path("results/formal/job_logs"))
    parser.add_argument(
        "--stop-after-media-s",
        type=float,
        default=0,
        help="screening only: stop after this many seconds of media playback",
    )
    parser.add_argument(
        "--max-screening-rebuffer-s",
        type=float,
        default=0,
        help="screening only: stop once cumulative rebuffering reaches this limit",
    )
    parser.add_argument("--buffer-time-default-s", type=float, default=60)
    parser.add_argument("--buffer-time-top-s", type=float, default=60)
    parser.add_argument("--buffer-time-top-long-s", type=float, default=60)
    parser.add_argument("--buffer-to-keep-s", type=float, default=20)
    parser.add_argument("--buffer-pruning-interval-s", type=float, default=10)
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    root = Path(__file__).resolve().parents[1]
    args.results = (root / args.results).resolve() if not args.results.is_absolute() else args.results
    args.logs = (root / args.logs).resolve() if not args.logs.is_absolute() else args.logs
    args.logs.mkdir(parents=True, exist_ok=True)

    with args.manifest.open(newline="", encoding="utf-8") as handle:
        traces = list(csv.DictReader(handle))
    jobs = []
    for trace in traces:
        for method in args.methods:
            output = args.results / method / f"{trace['trace_id']}.json"
            if valid_result(output):
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            jobs.append((method, trace, output))
    print(f"pending jobs={len(jobs)}, workers={args.workers}", flush=True)

    def run(job: tuple[str, dict[str, str], Path]) -> tuple[str, int]:
        method, trace, output = job
        identifier = job_id(method, trace["trace_id"])
        relative_output = output.relative_to(root / "results")
        command = [
            str(root / "run_one.sh"),
            method,
            trace["trace_path"],
            trace["start_second_of_minute"],
            str(relative_output),
            identifier,
        ]
        environment = os.environ.copy()
        environment["POLICY_ASSET"] = args.policy_asset
        if args.risk_threshold is not None:
            environment["RISK_THRESHOLD"] = str(args.risk_threshold)
        environment["BUFFER_TIME_DEFAULT_S"] = str(args.buffer_time_default_s)
        environment["BUFFER_TIME_TOP_S"] = str(args.buffer_time_top_s)
        environment["BUFFER_TIME_TOP_LONG_S"] = str(args.buffer_time_top_long_s)
        environment["BUFFER_TO_KEEP_S"] = str(args.buffer_to_keep_s)
        environment["BUFFER_PRUNING_INTERVAL_S"] = str(args.buffer_pruning_interval_s)
        stop_after_media_s = float(trace.get("stop_after_media_s") or args.stop_after_media_s)
        if stop_after_media_s > 0:
            environment["STOP_AFTER_MEDIA_S"] = str(stop_after_media_s)
        if args.max_screening_rebuffer_s > 0:
            environment["MAX_SCREENING_REBUFFER_S"] = str(args.max_screening_rebuffer_s)
        for column, variable in (
            ("probe_chunk", "PROBE_CHUNK"),
            ("probe_action", "PROBE_ACTION"),
            ("probe_rescue_chunk", "PROBE_RESCUE_CHUNK"),
            ("probe_rescue_action", "PROBE_RESCUE_ACTION"),
            ("probe_rescue_after_ms", "PROBE_RESCUE_AFTER_MS"),
        ):
            if trace.get(column):
                environment[variable] = trace[column]
        log_path = args.logs / f"{identifier}.log"
        with log_path.open("w", encoding="utf-8") as log:
            completed = subprocess.run(
                command,
                cwd=root,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
        return identifier, completed.returncode

    failures = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(run, job) for job in jobs]
        for index, future in enumerate(as_completed(futures), 1):
            identifier, returncode = future.result()
            print(f"[{index}/{len(jobs)}] {identifier}: rc={returncode}", flush=True)
            if returncode:
                failures.append(identifier)
    if failures:
        raise SystemExit(f"failed jobs ({len(failures)}): {', '.join(failures)}")


if __name__ == "__main__":
    main()
