#!/usr/bin/env bash
# Downloads the VideoAgentBench asset packs from the GitHub Release, checks them and unpacks them into
# benchmark/packs/<task>/. Tasks already present and intact are skipped.
# Usage: benchmark/scripts/fetch-packs.sh [task ...]        (default: all three)
# Env:   VAB_PACKS_URL  release download base (default https://github.com/$VAB_REPO/releases/download/$VAB_PACKS_TAG)
#        VAB_REPO (default satoshinji2992/video_agent), VAB_PACKS_TAG (default packs-v1), KEEP_ZIP=1 keeps the zips
set -euo pipefail
PACKS="$(cd "$(dirname "$0")/../packs" && pwd)"
BASE="${VAB_PACKS_URL:-https://github.com/${VAB_REPO:-satoshinji2992/video_agent}/releases/download/${VAB_PACKS_TAG:-packs-v1}}"
TASKS="${*:-task1-dart task2-coffee task3-glitch}"
cd "$PACKS"

intact() { awk -v t="$1/" 'index($2, t) == 1' SHA256SUMS | sha256sum --quiet -c - 2>/dev/null; }

for t in $TASKS; do
  want=$(awk -v z="$t.zip" '$2 == z {print $1}' ZIPSUMS)
  if [ -z "$want" ]; then echo "unknown task $t (not in ZIPSUMS)"; exit 1; fi
  if [ -d "$t" ] && intact "$t"; then echo "$t: already present and intact"; continue; fi
  if [ ! -f "$t.zip" ] || [ "$(sha256sum "$t.zip" | cut -d' ' -f1)" != "$want" ]; then
    echo "$t: downloading $BASE/$t.zip"
    curl -fL --retry 3 -o "$t.zip.part" "$BASE/$t.zip"
    mv "$t.zip.part" "$t.zip"
  fi
  got=$(sha256sum "$t.zip" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then echo "$t.zip: checksum mismatch ($got, expected $want)"; exit 1; fi
  rm -rf "$t"
  unzip -q "$t.zip"
  if ! intact "$t"; then echo "$t: unpacked files do not match SHA256SUMS"; exit 1; fi
  [ "${KEEP_ZIP:-}" = 1 ] || rm -f "$t.zip"
  echo "$t: ok"
done
