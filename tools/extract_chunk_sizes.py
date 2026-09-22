#!/usr/bin/env python3
"""Build the next-chunk-size table consumed by the SafeSABR policy."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


BITRATES_KBPS = [3000, 8000, 15000, 30000, 60000, 120000]
PATTERN = re.compile(r"^chunk-(\d+)-(\d+)\.m4s$")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("media_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    by_chunk: dict[int, dict[int, int]] = defaultdict(dict)
    for path in args.media_dir.glob("chunk-*-*.m4s"):
        match = PATTERN.match(path.name)
        if match:
            representation = int(match.group(1))
            chunk = int(match.group(2))
            by_chunk[chunk][representation] = path.stat().st_size
    if not by_chunk:
        raise ValueError(f"no DASH chunks found in {args.media_dir}")

    chunks = []
    for chunk_number in sorted(by_chunk):
        row = by_chunk[chunk_number]
        if set(row) != set(range(len(BITRATES_KBPS))):
            raise ValueError(f"chunk {chunk_number} has representations {sorted(row)}")
        chunks.append([row[index] for index in range(len(BITRATES_KBPS))])

    payload = {
        "schema": 1,
        "bitrates_kbps": BITRATES_KBPS,
        "chunks": chunks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(chunks)} chunk rows to {args.output}")


if __name__ == "__main__":
    main()
