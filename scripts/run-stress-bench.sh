#!/usr/bin/env bash
# Boots lastty in stress bench mode, waits for the JSON report to appear,
# then runs the summarizer. Builds via `tauri build --no-bundle` so the
# binary is configured to load the embedded dist (cargo run --release loads
# from devUrl and white-screens).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_FILE="${LASTTY_BENCH_OUTPUT:-/tmp/lastty-stress.json}"
DURATION_MS="${LASTTY_BENCH_DURATION_MS:-30000}"
PANES="${LASTTY_BENCH_PANES:-6}"
SCENARIOS="${LASTTY_BENCH_SCENARIOS:-streaming-text,color-cycle,fade,spinner-log,alt-screen-redraw,tool-burst}"
COLS="${LASTTY_BENCH_COLS:-120}"
ROWS="${LASTTY_BENCH_ROWS:-40}"
SIMULATOR_PATH="${LASTTY_BENCH_SIMULATOR:-$(pwd)/scripts/stress/simulate.mjs}"

rm -f "$OUT_FILE"

echo "Building lastty (release, --features bench) via tauri-cli..."
LASTTY_BENCH=1 \
pnpm tauri build --no-bundle --features bench >/tmp/lastty-stress-build.log 2>&1

TIMEOUT_SECS=$(( (DURATION_MS / 1000) + 60 ))

echo "Running stress bench (duration ${DURATION_MS}ms, ${PANES} panes)..."
LASTTY_BENCH_MODE=stress \
LASTTY_BENCH_OUTPUT="$OUT_FILE" \
LASTTY_BENCH_DURATION_MS="$DURATION_MS" \
LASTTY_BENCH_PANES="$PANES" \
LASTTY_BENCH_SCENARIOS="$SCENARIOS" \
LASTTY_BENCH_COLS="$COLS" \
LASTTY_BENCH_ROWS="$ROWS" \
LASTTY_BENCH_SIMULATOR="$SIMULATOR_PATH" \
./target/release/lastty >/tmp/lastty-stress.log 2>&1 &
PID=$!

cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 "$TIMEOUT_SECS"); do
  if [[ -f "$OUT_FILE" ]]; then
    wait "$PID" || true
    echo "Bench results written to $OUT_FILE"
    node scripts/stress/summarize-stress.mjs "$OUT_FILE"
    exit 0
  fi
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    if wait "$PID"; then
      STATUS=0
    else
      STATUS=$?
    fi
    echo "Bench process exited before writing $OUT_FILE (status $STATUS)"
    echo "Tauri log:"
    tail -n 200 /tmp/lastty-stress.log || true
    exit 1
  fi
  sleep 1
done

echo "Timed out waiting for bench output after ${TIMEOUT_SECS}s"
echo "Tauri log:"
tail -n 200 /tmp/lastty-stress.log || true
exit 1
