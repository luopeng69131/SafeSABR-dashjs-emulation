#!/usr/bin/env python3
"""Replay a StarNet throughput trace on a container-only network interface."""

from __future__ import annotations

import csv
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


TRACE_FILE = Path(os.environ.get("TRACE_FILE", "/traces/active.trace"))
INTERFACE = os.environ.get("SHAPER_INTERFACE", "eth0")
BASE_RTT_MS = max(float(os.environ.get("BASE_RTT_MS", "40")), 0.0)
GOODPUT_CALIBRATION_DENOMINATOR = max(
    float(os.environ.get("GOODPUT_CALIBRATION_DENOMINATOR", "1200")),
    1.0,
)
BURST_WINDOW_MS = max(float(os.environ.get("BURST_WINDOW_MS", "10")), 1.0)
CONTROL_PORT = int(os.environ.get("CONTROL_PORT", "8081"))
START = threading.Event()


def load_trace(path: Path) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    with path.open("r", encoding="utf-8") as handle:
        for row in csv.reader(handle, delimiter=" "):
            fields = [field for field in row if field]
            if not fields or fields[0].startswith("#"):
                continue
            if len(fields) < 2:
                raise ValueError(f"invalid trace row: {row!r}")
            timestamp_s = float(fields[0])
            throughput_mbps = max(float(fields[1]), 0.1)
            points.append((timestamp_s, throughput_mbps))
    if not points:
        raise ValueError(f"empty trace: {path}")
    points.sort(key=lambda item: item[0])
    if points[0][0] != 0:
        points.insert(0, (0.0, points[0][1]))
    return points


def run_tc(*args: str) -> None:
    subprocess.run(["tc", *args], check=True)


def set_rate(throughput_mbps: float, initialize: bool = False) -> None:
    if initialize:
        run_tc("qdisc", "replace", "dev", INTERFACE, "root", "handle", "1:", "htb", "default", "10")
    shaped_mbps = throughput_mbps + (
        throughput_mbps * throughput_mbps / GOODPUT_CALIBRATION_DENOMINATOR
    )
    rate = f"{shaped_mbps:.3f}mbit"
    # Keep enough HTB tokens for scheduler operation without injecting a large
    # burst whenever a one-second trace update changes the class rate.
    burst_bytes = max(
        64 * 1024,
        int(shaped_mbps * 1_000_000 / 8 * BURST_WINDOW_MS / 1000),
    )
    burst = f"{burst_bytes}b"
    class_command = "replace" if initialize else "change"
    run_tc(
        "class", class_command, "dev", INTERFACE, "parent", "1:",
        "classid", "1:10", "htb", "rate", rate, "ceil", rate,
        "burst", burst, "cburst", burst,
    )
    if initialize:
        run_tc(
            "qdisc", "replace", "dev", INTERFACE, "parent", "1:10",
            "handle", "10:", "netem", "delay", f"{BASE_RTT_MS:.3f}ms",
            "limit", "100000",
        )


class ControlHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/start":
            body = json.dumps({
                "started": True,
                "trace": TRACE_FILE.name,
                # Exposed only so the diagnostic oracle-rescue mode can measure
                # the attainable upper bound of the runtime stage.
                "trace_points": load_trace(TRACE_FILE),
            }).encode()
            self.send_response(200)
            self._headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            START.set()
            return
        if self.path.rstrip("/") == "/status":
            body = json.dumps({"started": START.is_set(), "trace": TRACE_FILE.name}).encode()
            self.send_response(200)
            self._headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def _headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def log_message(self, fmt: str, *args: object) -> None:
        print(json.dumps({"control": fmt % args}), flush=True)


def main() -> None:
    points = load_trace(TRACE_FILE)
    set_rate(points[0][1], initialize=True)
    server = ThreadingHTTPServer(("0.0.0.0", CONTROL_PORT), ControlHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps({
        "event": "shaper_ready",
        "trace": str(TRACE_FILE),
        "points": len(points),
        "initial_mbps": points[0][1],
        "goodput_calibration_denominator": GOODPUT_CALIBRATION_DENOMINATOR,
        "burst_window_ms": BURST_WINDOW_MS,
        "rtt_ms": BASE_RTT_MS,
    }), flush=True)

    START.wait()
    started = time.monotonic()
    print(json.dumps({"event": "trace_started", "monotonic_s": started}), flush=True)
    for timestamp_s, throughput_mbps in points[1:]:
        delay_s = started + timestamp_s - time.monotonic()
        if delay_s > 0:
            time.sleep(delay_s)
        set_rate(throughput_mbps)
        print(json.dumps({
            "event": "rate_change",
            "trace_time_s": timestamp_s,
            "throughput_mbps": throughput_mbps,
        }), flush=True)

    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
