#!/usr/bin/env bash
# ============================================================
# prep-node-tiles.sh — split an N×M illustration grid into clean, named node
# tiles for the product cards. THIS IS THE CANONICAL RECORD of the illustration
# workflow; the front-end files reference it rather than repeat it.
#
# PIPELINE (end to end):
#   1. GENERATE a square N×M grid — one concept per cell — on ONE flat light gray
#      ground (~#ededed); NO white background / matte / vignette / separators.
#      Accent = orange wedge (hue 8–32°) for pages 1–2, BLUE wedge (210–228°) for
#      the page-3 composition cells.
#   2. SPLIT + FLATTEN with this script (it prints each tile's flat ground hex).
#   3. WIRE the tiles in the front-end, setting each card's background to that
#      printed ground so object + ground are ONE surface (grey at rest, blooms
#      the accent when active):
#        · app/_sections/ProductScreens.tsx  →  NODE_ART[id] = { src, ground }
#        · app/_sections/ComposeOutro.tsx     →  FORMATS[].art   (page-3 cells)
#
# The image model renders each panel with a bright studio VIGNETTE (corners and
# edges glow lighter than the centre) plus faint separators between panels.
# Against the card that perimeter halo reads as "white edges". So after splitting
# we FLATTEN it: flood-fill inward from the bright perimeter, replacing the halo
# + ground with one flat colour. The fill is edge-connected and the object /
# orbit-dots / contact-shadow are darker than the fuzz floor, so they survive —
# only the background is flattened.
#
# Each tile's flat ground hex is printed; set the matching card background
# (NODE_ART[*].ground in ProductScreens.tsx) to it so the object and its ground
# are one seamless surface.
#
# Usage:
#   scripts/prep-node-tiles.sh <grid.png> <out-dir> <name1> <name2> ...
# Names are ROW-MAJOR (left→right, top→bottom). Grid shape via COLS/ROWS:
#   COLS=2 ROWS=2  (default)  — a 2×2 grid, 4 names
#   COLS=2 ROWS=1             — a 1×2 row,  2 names
# Tune the flatten with FUZZ=<pct> (default 7). Force ONE flat ground across all
# tiles (cross-batch consistency) with GROUND=#ededed.
# ============================================================
set -euo pipefail

IN=${1:?usage: prep-node-tiles.sh <grid.png> <out-dir> <name...>}
OUT=${2:?missing out dir}
shift 2
NAMES=("$@")
COLS=${COLS:-2}
ROWS=${ROWS:-2}
FUZZ=${FUZZ:-7}
GROUND=${GROUND:-}   # optional: force ALL tiles to this flat ground (e.g. #ededed)

command -v magick >/dev/null || { echo "magick (ImageMagick) required" >&2; exit 1; }
[ "${#NAMES[@]}" -eq $((COLS * ROWS)) ] || {
  echo "need $((COLS * ROWS)) names for a ${COLS}×${ROWS} grid, got ${#NAMES[@]}" >&2; exit 1; }
mkdir -p "$OUT"

read -r W H < <(magick identify -format "%w %h\n" "$IN")
TW=$((W / COLS)); TH=$((H / ROWS))

clean() { # <x> <y> <name>
  local x=$1 y=$2 name=$3
  local tmp="$OUT/.$name.tmp.png"
  magick "$IN" -crop "${TW}x${TH}+${x}+${y}" +repage "$tmp"
  local mx=$((TW - 1)) my=$((TH - 1)) cx=$((TW / 2)) cy=$((TH / 2))
  # ground = forced GROUND, else sampled from a strip just inside the top edge.
  local bg
  if [ -n "$GROUND" ]; then
    bg="$GROUND"
  else
    bg=$(magick "$tmp" -gravity North -crop "$((TW * 2 / 3))x10+0+40" +repage \
           -resize '1x1!' -format "%[pixel:p{0,0}]" info:)
  fi
  # flood-fill inward from all four corners + edge midpoints
  magick "$tmp" -fuzz "${FUZZ}%" -fill "$bg" \
    -draw "color 1,1 floodfill"      -draw "color ${mx},1 floodfill" \
    -draw "color 1,${my} floodfill"  -draw "color ${mx},${my} floodfill" \
    -draw "color ${cx},1 floodfill"  -draw "color ${cx},${my} floodfill" \
    -draw "color 1,${cy} floodfill"  -draw "color ${mx},${cy} floodfill" \
    "$OUT/$name.png"
  rm -f "$tmp"
  local hex
  hex=$(magick "$OUT/$name.png" -crop 1x1+2+2 +repage txt: | grep -oE '#[0-9A-Fa-f]{6}' | head -1)
  printf "  %-14s ground=%s\n" "$name" "$hex"
}

echo "flattened ground per tile (set NODE_ART[*].ground to these):"
i=0
for ((r = 0; r < ROWS; r++)); do
  for ((c = 0; c < COLS; c++)); do
    clean $((c * TW)) $((r * TH)) "${NAMES[$i]}"
    i=$((i + 1))
  done
done

echo "wrote ${#NAMES[@]} tiles to $OUT"
