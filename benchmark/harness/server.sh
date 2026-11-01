#!/usr/bin/env bash
# Starts or stops the app build under test for the harness, with its data in ./data.
# Usage: ./server.sh start [port]   |   ./server.sh stop [port]
# Env: VEVAL_APP_DIR (default: this repo), VEVAL_ENV_FILE (default <app>/.env), SKILLS_DIR (default <app>/skills)
set -euo pipefail
SC="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "${VEVAL_APP_DIR:-$SC/../..}" && pwd)"
# The app's env file (API keys for Claude, Seedance, speech and search). An env file without ANTHROPIC_* makes the app's Claude use this machine's Claude Code login.
ENV_FILE="${VEVAL_ENV_FILE:-$APP/.env}"
PORT="${2:-${PORT:-8790}}"
PIDFILE="$SC/logs/server-$PORT.pid"
LOG="$SC/logs/server-$PORT.log"
mkdir -p "$SC/data" "$SC/logs"

case "${1:-}" in
start)
  if ss -ltn | grep -q ":$PORT\b"; then echo "port $PORT is already in use"; exit 1; fi
  [ -f "$SC/data/settings.json" ] || echo '{"reviewEnabled":false,"memoryAutoUpdate":false,"chatModel":"claude-opus-5-5","effort":"medium","seedanceModel":"doubao-seedance-2-5-260628","voiceover":true,"voiceZh":"zhMale","voiceEn":"enMale","syncAudio":true}' > "$SC/data/settings.json"
  [ -f "$SC/data/skills.json" ] || echo '{"skills":{"video-shotcraft":{"enabled":true,"source":"https://github.com/Vincentwei1021/video-shotcraft","commit":"1266a3ec4831289c4d893d42dd5102723658039a","installedAt":"2026-10-31T07:35:54.334Z"}}}' > "$SC/data/skills.json"
  # setsid: the server runs in its own process group so stop can end npx, tsx and node together.
  (cd "$APP" && PORT="$PORT" HOST=127.0.0.1 DATA_DIR="$SC/data" SKILLS_DIR="${SKILLS_DIR:-$APP/skills}" \
    setsid nohup npx tsx --env-file="$ENV_FILE" src/server.ts > "$LOG" 2>&1 & echo $! > "$PIDFILE")
  for _ in $(seq 1 180); do
    if grep -q 'warm-up' "$LOG" 2>/dev/null; then grep -E 'video agent demo|warm-up' "$LOG" | sed -E 's#https?://[^ ]+/api/v3#<seedance>#'; exit 0; fi
    sleep 1
  done
  echo "no warm-up line after 180 s; see $LOG"; exit 1
  ;;
stop)
  if [ -f "$PIDFILE" ]; then kill -TERM -- "-$(cat "$PIDFILE")" 2>/dev/null || kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
  sleep 2
  # tsx re-spawns node outside the process group: stop the listener too, but only if it is this harness's instance.
  for pid in $(ss -ltnp 2>/dev/null | grep ":$PORT\b" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "DATA_DIR=$SC/data"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  sleep 1
  if ss -ltn | grep -q ":$PORT\b"; then echo "something still listens on $PORT (not started by this script?)"; exit 1; fi
  echo "stopped $PORT"
  ;;
*) echo "usage: $0 start|stop [port]"; exit 2 ;;
esac
