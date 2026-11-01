#!/bin/bash
# usage: early.sh <out.jpg> <clip.mp4>...  8 frames from 0.1 s to 1.5 s per clip, one row per clip.
out=$1; shift
T="$(cd "$(dirname "$0")/.." && pwd)/tmp/early.$$"; mkdir -p $T; r=0
for c in "$@"; do
  w=$(ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$c" | head -1 | cut -d, -f1)
  sc=$([ "$w" -lt 1500 ] && echo "scale=150:-2" || echo "scale=260:-2")
  i=0; for t in 0.1 0.3 0.45 0.6 0.75 0.9 1.1 1.4; do
    ffmpeg -hide_banner -loglevel error -y -ss $t -i "$c" -frames:v 1 -vf "$sc" $T/f$i.png; i=$((i+1)); done
  ffmpeg -hide_banner -loglevel error -y -i $T/f%d.png -vf "tile=8x1:padding=3,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='$(basename $(dirname $c))':fontcolor=yellow:fontsize=16:box=1:boxcolor=black@0.6:x=4:y=4" $T/row$r.png; r=$((r+1))
done
ffmpeg -hide_banner -loglevel error -y -i $T/row%d.png -vf "tile=1x$r:padding=3" "$out"; rm -rf $T
