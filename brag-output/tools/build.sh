#!/usr/bin/env bash
# Rebuilds both brag videos from index.tpl.html: generate, measure cursor targets, check, render, bake the poster.
# Usage: brag-output/tools/build.sh            (from anywhere; needs Node 22+, ffmpeg and Playwright's Chromium)
set -euo pipefail
T="$(cd "$(dirname "$0")" && pwd)"; O="$T/.."
export HYPERFRAMES_NO_TELEMETRY=1
for fmt in landscape vertical; do
  if [[ $fmt == vertical ]]; then dir=composition-vertical out=brag-vertical w=1080 h=1920; else dir=composition out=brag w=1920 h=1080; fi
  # generate once, measure where the cursor has to click in this layout, then generate with those targets
  FORMAT=$fmt node "$T/gen.mjs" "$(cat "$T/targets-$fmt.json")" >/dev/null
  node "$T/targets.cjs" $w $h "$O/$dir/index.html" > "$T/targets-$fmt.json"
  FORMAT=$fmt node "$T/gen.mjs" "$(cat "$T/targets-$fmt.json")"
  (cd "$O/$dir" && npx hyperframes check && npx hyperframes render --quality delivery -o "../$out.mp4")
  # the poster (logo on purple, from ../poster.html) becomes frame 0, so link previews show it
  ffmpeg -v error -y -i "$O/$out.mp4" -i "$O/$out.jpg" -filter_complex "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]" \
    -map "[v]" -map "0:a?" -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -c:a copy -movflags +faststart "$O/$out.poster.mp4"
  mv "$O/$out.poster.mp4" "$O/$out.mp4"
done
