#!/bin/bash
# usage: run.sh <script.mts> [args...]   (BENCH_RES=720p to switch resolution)
# Runs a generator script with the app's providers from this repo; work, logs and the ledger stay in benchmark/tools.
TOOLS="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$TOOLS/../.." && pwd)"
RES=${BENCH_RES:-1080p}
mkdir -p "$TOOLS/tmp"
cd "$REPO" && ENABLE_HD=true VIDEO_RESOLUTION=$RES DATA_DIR=$TOOLS/data SEEDANCE_DRAFT=false \
  SEEDANCE_MAX_CONCURRENT=4 BUDGET_LIMIT_USD=5000 TMPDIR=$TOOLS/tmp \
  exec npx tsx --env-file="${BENCH_ENV_FILE:-$REPO/.env}" "$@"
