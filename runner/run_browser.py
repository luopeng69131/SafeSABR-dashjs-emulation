#!/usr/bin/env python3
"""Run one real dash.js playback session and persist browser-side metrics."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import WebDriverException


SELENIUM_URL = os.environ.get("SELENIUM_URL", "http://chrome:4444/wd/hub")
PLAYER_URL = os.environ.get("PLAYER_URL", "http://web/")
MPD_URL = os.environ.get("MPD_URL", "http://media:8080/video/stream.mpd")
SHAPER_START_URL = os.environ.get("SHAPER_START_URL", "http://media:8081/start")
METHOD = os.environ.get("METHOD", "dash_dynamic")
SESSION_ID = os.environ.get("SESSION_ID", "manual")
TRACE_ID = os.environ.get("TRACE_ID", "smoke.trace")
TRACE_START_SECOND = float(os.environ.get("TRACE_START_SECOND", "0"))
POLICY_SEED = int(os.environ.get("POLICY_SEED", "42"))
POLICY_ASSET = os.environ.get("POLICY_ASSET", "safesabr_seed42.json")
RISK_THRESHOLD = os.environ.get("RISK_THRESHOLD", "")
TIMEOUT_S = float(os.environ.get("PLAYBACK_TIMEOUT_S", "300"))
STOP_AFTER_MEDIA_S = float(os.environ.get("STOP_AFTER_MEDIA_S", "0"))
MAX_SCREENING_REBUFFER_S = float(os.environ.get("MAX_SCREENING_REBUFFER_S", "0"))
PROBE_CHUNK = int(os.environ.get("PROBE_CHUNK", "-1"))
PROBE_ACTION = int(os.environ.get("PROBE_ACTION", "-1"))
PROBE_RESCUE_CHUNK = int(os.environ.get("PROBE_RESCUE_CHUNK", "-1"))
PROBE_RESCUE_ACTION = int(os.environ.get("PROBE_RESCUE_ACTION", "-1"))
PROBE_RESCUE_AFTER_MS = int(os.environ.get("PROBE_RESCUE_AFTER_MS", "500"))
BUFFER_TIME_DEFAULT_S = float(os.environ.get("BUFFER_TIME_DEFAULT_S", "60"))
BUFFER_TIME_TOP_S = float(os.environ.get("BUFFER_TIME_TOP_S", "60"))
BUFFER_TIME_TOP_LONG_S = float(os.environ.get("BUFFER_TIME_TOP_LONG_S", "60"))
BUFFER_TO_KEEP_S = float(os.environ.get("BUFFER_TO_KEEP_S", "20"))
BUFFER_PRUNING_INTERVAL_S = float(os.environ.get("BUFFER_PRUNING_INTERVAL_S", "10"))
RESULT_PATH = Path(os.environ.get("RESULT_PATH", "/results/result.json"))


def webdriver_post(driver: webdriver.Remote, suffix: str, payload: dict) -> object:
    endpoint = (
        f"{SELENIUM_URL.rstrip('/')}/session/{driver.session_id}/{suffix.lstrip('/')}"
    )
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode("utf-8"))
    return result.get("value")


def get_remote_log(driver: webdriver.Remote, log_type: str) -> list[dict]:
    if hasattr(driver, "get_log"):
        return driver.get_log(log_type)
    value = webdriver_post(driver, "se/log", {"type": log_type})
    return value if isinstance(value, list) else []


def connect() -> webdriver.Remote:
    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--autoplay-policy=no-user-gesture-required")
    options.add_argument("--mute-audio")
    options.add_argument("--disable-background-timer-throttling")
    options.add_argument("--disable-renderer-backgrounding")
    options.add_argument("--window-size=1280,720")
    options.set_capability(
        "goog:loggingPrefs", {"browser": "ALL", "performance": "ALL"}
    )
    options.set_capability(
        "goog:perfLoggingPrefs", {"enableNetwork": True, "enablePage": False}
    )
    deadline = time.monotonic() + 90
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            driver = webdriver.Remote(command_executor=SELENIUM_URL, options=options)
            try:
                if hasattr(driver, "execute_cdp_cmd"):
                    driver.execute_cdp_cmd("Network.enable", {})
                else:
                    webdriver_post(
                        driver,
                        "goog/cdp/execute",
                        {"cmd": "Network.enable", "params": {}},
                    )
            except Exception:
                pass
            return driver
        # urllib3 may fail before Selenium can wrap the startup error, so retry
        # every connection exception while the remote browser is booting.
        except Exception as error:
            last_error = error
            time.sleep(2)
    raise RuntimeError(f"Selenium was not ready: {last_error}")


def summarize_network_requests(logs: list[dict]) -> list[dict]:
    """Extract media-request cache and wire-byte evidence from CDP logs."""
    requests: dict[str, dict] = {}
    for entry in logs:
        try:
            message = json.loads(entry["message"])["message"]
            method = message["method"]
            params = message.get("params", {})
            request_id = str(params.get("requestId", ""))
        except (KeyError, TypeError, ValueError):
            continue
        if not request_id or not method.startswith("Network."):
            continue
        record = requests.setdefault(request_id, {"cdp_request_id": request_id})
        if method == "Network.requestWillBeSent":
            request = params.get("request", {})
            record.update(
                {
                    "url": request.get("url"),
                    "method": request.get("method"),
                    "resource_type": params.get("type"),
                    "request_timestamp_s": params.get("timestamp"),
                    "request_wall_time_s": params.get("wallTime"),
                }
            )
        elif method == "Network.requestServedFromCache":
            record["served_from_cache_event"] = True
        elif method == "Network.responseReceived":
            response = params.get("response", {})
            record.update(
                {
                    "response_timestamp_s": params.get("timestamp"),
                    "status": response.get("status"),
                    "mime_type": response.get("mimeType"),
                    "protocol": response.get("protocol"),
                    "from_disk_cache": bool(response.get("fromDiskCache", False)),
                    "from_service_worker": bool(
                        response.get("fromServiceWorker", False)
                    ),
                    "response_encoded_bytes": response.get("encodedDataLength"),
                }
            )
        elif method == "Network.loadingFinished":
            record.update(
                {
                    "finished_timestamp_s": params.get("timestamp"),
                    "encoded_data_length": params.get("encodedDataLength"),
                }
            )
        elif method == "Network.dataReceived":
            record["data_length"] = float(record.get("data_length") or 0) + float(
                params.get("dataLength") or 0
            )
            record["received_encoded_data_length"] = float(
                record.get("received_encoded_data_length") or 0
            ) + float(params.get("encodedDataLength") or 0)
        elif method == "Network.loadingFailed":
            record.update(
                {
                    "failed_timestamp_s": params.get("timestamp"),
                    "failure_text": params.get("errorText"),
                    "canceled": bool(params.get("canceled", False)),
                }
            )

    media = []
    for record in requests.values():
        url = str(record.get("url") or "")
        if "/video/" not in url:
            continue
        from_cache = bool(
            record.get("served_from_cache_event")
            or record.get("from_disk_cache")
            or record.get("from_service_worker")
        )
        encoded = max(
            float(record.get("encoded_data_length") or 0),
            float(record.get("received_encoded_data_length") or 0),
        )
        record["from_cache"] = from_cache
        record["wire_bytes"] = 0 if from_cache else encoded
        media.append(record)
    return sorted(
        media,
        key=lambda record: float(record.get("request_timestamp_s") or 0),
    )


def main() -> int:
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    driver = connect()
    query = urllib.parse.urlencode({
        "method": METHOD,
        "mpd": MPD_URL,
        "shaper": SHAPER_START_URL,
        "session": SESSION_ID,
        "trace_id": TRACE_ID,
        "start_second": TRACE_START_SECOND,
        "seed": POLICY_SEED,
        "policy_asset": POLICY_ASSET,
        "risk_threshold": RISK_THRESHOLD,
        "stop_after_media_s": STOP_AFTER_MEDIA_S,
        "max_screening_rebuffer_s": MAX_SCREENING_REBUFFER_S,
        "probe_chunk": PROBE_CHUNK,
        "probe_action": PROBE_ACTION,
        "probe_rescue_chunk": PROBE_RESCUE_CHUNK,
        "probe_rescue_action": PROBE_RESCUE_ACTION,
        "probe_rescue_after_ms": PROBE_RESCUE_AFTER_MS,
        "buffer_time_default_s": BUFFER_TIME_DEFAULT_S,
        "buffer_time_top_s": BUFFER_TIME_TOP_S,
        "buffer_time_top_long_s": BUFFER_TIME_TOP_LONG_S,
        "buffer_to_keep_s": BUFFER_TO_KEEP_S,
        "buffer_pruning_interval_s": BUFFER_PRUNING_INTERVAL_S,
    })
    url = f"{PLAYER_URL}?{query}"
    started = time.monotonic()
    result = None
    try:
        try:
            if hasattr(driver, "execute_cdp_cmd"):
                driver.execute_cdp_cmd("Network.clearBrowserCache", {})
            else:
                webdriver_post(
                    driver,
                    "goog/cdp/execute",
                    {"cmd": "Network.clearBrowserCache", "params": {}},
                )
        except Exception:
            pass
        driver.get(url)
        deadline = time.monotonic() + TIMEOUT_S
        while time.monotonic() < deadline:
            result = driver.execute_script("return window.__SAFESABR_RESULT__ || null;")
            if result is not None:
                break
            time.sleep(0.5)
        if result is None:
            result = driver.execute_script("return window.__SAFESABR_EXPERIMENT__ || {};")
            result["fatal_error"] = f"playback timed out after {TIMEOUT_S:.1f} s"
            result["terminal_state"] = driver.execute_script("""
                const video = document.getElementById('video');
                const ranges = [];
                for (let index = 0; index < video.buffered.length; index += 1) {
                    ranges.push([video.buffered.start(index), video.buffered.end(index)]);
                }
                return {
                    current_time_s: video.currentTime,
                    duration_s: video.duration,
                    paused: video.paused,
                    ended: video.ended,
                    seeking: video.seeking,
                    ready_state: video.readyState,
                    network_state: video.networkState,
                    buffered_ranges: ranges,
                    visibility_state: document.visibilityState,
                };
            """)
            driver.save_screenshot(str(RESULT_PATH.with_suffix(".png")))
        try:
            browser_logs = get_remote_log(driver, "browser")
        except (AttributeError, WebDriverException):
            browser_logs = []
        performance_log_entries = 0
        performance_log_error = None
        try:
            performance_logs = get_remote_log(driver, "performance")
            performance_log_entries = len(performance_logs)
            network_requests = summarize_network_requests(performance_logs)
        except Exception as error:
            network_requests = []
            performance_log_error = repr(error)
        result["runner"] = {
            "url": url,
            "elapsed_s": time.monotonic() - started,
            "browser_logs": browser_logs,
            "network_requests": network_requests,
            "performance_log_entries": performance_log_entries,
            "performance_log_error": performance_log_error,
        }
    except Exception as error:  # preserve evidence before returning failure
        result = {
            "method": METHOD,
            "session_id": SESSION_ID,
            "fatal_error": repr(error),
            "runner_elapsed_s": time.monotonic() - started,
        }
        try:
            driver.save_screenshot(str(RESULT_PATH.with_suffix(".png")))
        except Exception:
            pass
    finally:
        driver.quit()

    RESULT_PATH.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({
        "result": str(RESULT_PATH),
        "method": METHOD,
        "fatal_error": result.get("fatal_error"),
        "metrics": result.get("metrics"),
    }, sort_keys=True))
    return 1 if result.get("fatal_error") else 0


if __name__ == "__main__":
    sys.exit(main())
