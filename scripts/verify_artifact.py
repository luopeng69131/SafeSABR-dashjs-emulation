#!/usr/bin/env python3
"""Validate public artifacts and, optionally, local evaluation inputs."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_HASHES = {
    "app/assets/safesabr_seed42.json":
        "0aafb6c46d8be923813cb9b2e8f968c238bd89c24cbe986c08c89959d50c3476",
    "app/assets/safesabr_risk_critic.json":
        "98630576dc0b406a85f094e78edb42a8537a08f2d34265a7b887dff57370f9be",
    "app/vendor/dash.all.min.js":
        "919c84e9602cf13f6b4dca628b1a96bcec6dab5857f43748d390408214b1e990",
}


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"artifact verification failed: {message}")


def verify_hashes() -> None:
    for relative, expected in EXPECTED_HASHES.items():
        path = ROOT / relative
        require(path.is_file(), f"missing {relative}")
        require(digest(path) == expected, f"checksum mismatch for {relative}")


def verify_models() -> None:
    policy = json.loads((ROOT / "app/assets/safesabr_seed42.json").read_text())
    require(policy.get("observation_size") == 25, "unexpected policy observation size")
    require(policy.get("action_size") == 6, "unexpected policy action size")
    require(
        policy.get("bitrate_ladder_kbps") == [3000, 8000, 15000, 30000, 60000, 120000],
        "unexpected policy bitrate ladder",
    )
    critic = json.loads((ROOT / "app/assets/safesabr_risk_critic.json").read_text())
    require(bool(critic.get("trees")), "risk model contains no trees")
    require(0 < float(critic.get("threshold", 0)) < 1, "invalid risk threshold")


def verify_traces(manifest_path: Path) -> None:
    manifest_path = ROOT / manifest_path
    require(manifest_path.is_file(), f"missing local trace manifest: {manifest_path}; see docs/DATASET.md")
    with manifest_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(len(rows) == 30, f"expected 30 manifest rows, found {len(rows)}")
    require(len({row["trace_id"] for row in rows}) == 30, "trace IDs are not unique")
    require(
        len({row["source_recording_id"] for row in rows}) == 30,
        "source recording IDs are not unique",
    )
    require(
        Counter(row["region"] for row in rows) == {"us": 10, "osn": 10, "vic": 10},
        "expected 10 traces from each region",
    )
    for row in rows:
        full_path = ROOT / row["trace_path"]
        require(full_path.is_file(), f"missing local trace: {full_path}; see docs/DATASET.md")
        with full_path.open(encoding="utf-8") as handle:
            points = [line.split() for line in handle if line.strip()]
        require(len(points) >= 193, f"trace is too short: {full_path}")
        require(all(len(point) == 2 for point in points), f"invalid trace row: {full_path}")


def verify_media() -> None:
    manifest = ROOT / "media/formal/stream.mpd"
    chunk_sizes = ROOT / "app/assets/chunk_sizes.json"
    require(manifest.is_file(), "generated media manifest is missing")
    require(chunk_sizes.is_file(), "generated chunk-size metadata is missing")
    payload = json.loads(chunk_sizes.read_text())
    require(len(payload.get("chunks", [])) == 48, "expected 48 generated media chunks")
    require(
        payload.get("bitrates_kbps") == [3000, 8000, 15000, 30000, 60000, 120000],
        "generated media bitrate ladder is incorrect",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-media", action="store_true")
    parser.add_argument("--trace-manifest", type=Path, help="also validate local traces and their manifest")
    args = parser.parse_args()
    verify_hashes()
    verify_models()
    if args.trace_manifest is not None:
        verify_traces(args.trace_manifest)
    if args.require_media:
        verify_media()
    print("artifact verification passed: models and pinned dash.js")
    if args.trace_manifest is not None:
        print("local trace verification passed: 30 windows from distinct recordings")


if __name__ == "__main__":
    main()
