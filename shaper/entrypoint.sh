#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f /.dockerenv ]]; then
    echo "refusing to run traffic shaping outside Docker" >&2
    exit 97
fi

iface="${SHAPER_INTERFACE:-eth0}"
if [[ ! -d "/sys/class/net/${iface}" ]]; then
    echo "network interface ${iface} does not exist" >&2
    exit 98
fi

if [[ -e "/sys/class/net/${iface}/device" ]]; then
    echo "refusing to shape physical interface ${iface}" >&2
    exit 99
fi

python3 /opt/safesabr/replay_trace.py &
shaper_pid=$!

cleanup() {
    kill "${shaper_pid}" 2>/dev/null || true
    tc qdisc del dev "${iface}" root 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec nginx -g 'daemon off;'
