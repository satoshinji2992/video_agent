#!/usr/bin/env bash
# Packs each VideoAgentBench task folder into one zip for the GitHub Release and writes their checksums.
# The source folders are checked against benchmark/packs/SHA256SUMS first, and nothing outside that list is packed.
# Usage: benchmark/scripts/pack-release.sh [source dir holding task1-dart/ task2-coffee/ task3-glitch/] [output dir]
#   defaults: source = benchmark/packs, output = ../video_agent_release (next to the repo, outside git)
# Output: <out>/<task>.zip and <out>/ZIPSUMS; ZIPSUMS is also copied to benchmark/packs/ZIPSUMS (commit that file).
set -euo pipefail
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$BENCH/.." && pwd)"
SRC="$(cd "${1:-$BENCH/packs}" && pwd)"
OUT="${2:-$REPO/../video_agent_release}"
SUMS="$BENCH/packs/SHA256SUMS"
TASKS="task1-dart task2-coffee task3-glitch"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

echo "checking $SRC against SHA256SUMS"
(cd "$SRC" && sha256sum --quiet -c "$SUMS")
for t in $TASKS; do
  extra=$(cd "$SRC" && comm -13 <(awk -v t="$t/" 'index($2, t) == 1 {print $2}' "$SUMS" | LC_ALL=C sort) <(find "$t" -type f | LC_ALL=C sort))
  if [ -n "$extra" ]; then echo "files in $t not listed in SHA256SUMS (left out of the zip):"; echo "$extra" | sed 's/^/  /'; fi
done

: > "$OUT/ZIPSUMS"
for t in $TASKS; do
  rm -f "$OUT/$t.zip"
  # Only the listed files, in a fixed order, without extra file attributes.
  (cd "$SRC" && awk -v t="$t/" 'index($2, t) == 1 {print $2}' "$SUMS" | LC_ALL=C sort | zip -X -q "$OUT/$t.zip" -@)
  (cd "$OUT" && sha256sum "$t.zip" >> ZIPSUMS)
  echo "$t.zip  $(du -h "$OUT/$t.zip" | cut -f1)"
done
cp "$OUT/ZIPSUMS" "$BENCH/packs/ZIPSUMS"
echo "wrote $OUT/ZIPSUMS and benchmark/packs/ZIPSUMS"
