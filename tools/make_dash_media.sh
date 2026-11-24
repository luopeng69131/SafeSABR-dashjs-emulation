#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
duration_s="${1:-24}"
output_dir="${2:-${root}/media}"
image="${MEDIA_BUILDER_IMAGE:-safesabr-media-builder:24.04}"

mkdir -p "${output_dir}"
docker build -q -t "${image}" -f "${root}/tools/media-builder.Dockerfile" "${root}/tools" >/dev/null

docker run --rm \
    -v "${output_dir}:/output" \
    "${image}" \
    bash -lc "rm -f /output/*.m4s /output/*.mpd; \
      ffmpeg -hide_banner -loglevel warning -y \
      -f lavfi -i 'testsrc2=size=1280x720:rate=30:duration=${duration_s}' \
      -filter_complex '[0:v]split=6[v0][v1][v2][v3][v4][v5]' \
      -map '[v0]' -map '[v1]' -map '[v2]' -map '[v3]' -map '[v4]' -map '[v5]' \
      -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 120 -keyint_min 120 -sc_threshold 0 \
      -b:v:0 3000k   -minrate:v:0 3000k   -maxrate:v:0 3000k   -bufsize:v:0 6000k \
      -b:v:1 8000k   -minrate:v:1 8000k   -maxrate:v:1 8000k   -bufsize:v:1 16000k \
      -b:v:2 15000k  -minrate:v:2 15000k  -maxrate:v:2 15000k  -bufsize:v:2 30000k \
      -b:v:3 30000k  -minrate:v:3 30000k  -maxrate:v:3 30000k  -bufsize:v:3 60000k \
      -b:v:4 60000k  -minrate:v:4 60000k  -maxrate:v:4 60000k  -bufsize:v:4 120000k \
      -b:v:5 120000k -minrate:v:5 120000k -maxrate:v:5 120000k -bufsize:v:5 240000k \
      -x264-params:v:0 'nal-hrd=cbr:force-cfr=1' \
      -x264-params:v:1 'nal-hrd=cbr:force-cfr=1' \
      -x264-params:v:2 'nal-hrd=cbr:force-cfr=1' \
      -x264-params:v:3 'nal-hrd=cbr:force-cfr=1' \
      -x264-params:v:4 'nal-hrd=cbr:force-cfr=1' \
      -x264-params:v:5 'nal-hrd=cbr:force-cfr=1' \
      -f dash -seg_duration 4 -use_template 1 -use_timeline 0 \
      -init_seg_name 'init-\$RepresentationID\$.m4s' \
      -media_seg_name 'chunk-\$RepresentationID\$-\$Number%05d\$.m4s' \
      -adaptation_sets 'id=0,streams=v' /output/stream.mpd"

python3 "${root}/tools/extract_chunk_sizes.py" \
    "${output_dir}" "${root}/app/assets/chunk_sizes.json"

echo "generated DASH media in ${output_dir}"
