#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_FILE="${1:-/tmp/lastty-xterm-bench.json}"
BENCH_COLS="${LASTTY_BENCH_COLS:-221}"
BENCH_ROWS="${LASTTY_BENCH_ROWS:-61}"
BENCH_ITERATIONS="${LASTTY_BENCH_ITERATIONS:-20}"
BENCH_WARMUP="${LASTTY_BENCH_WARMUP:-5}"
rm -f "$OUT_FILE"

run_cmd() {
  if command -v nix >/dev/null 2>&1; then
    nix develop -c "$@"
  else
    "$@"
  fi
}

echo "Building lastty (release, --features bench) via tauri-cli..."
LASTTY_BENCH=1 \
run_cmd pnpm tauri build --no-bundle --features bench >/tmp/lastty-xterm-bench-build.log 2>&1

echo "Running xterm benchmark in Tauri..."
LASTTY_BENCH_MODE=xterm \
LASTTY_BENCH_OUTPUT="$OUT_FILE" \
LASTTY_BENCH_COLS="$BENCH_COLS" \
LASTTY_BENCH_ROWS="$BENCH_ROWS" \
LASTTY_BENCH_ITERATIONS="$BENCH_ITERATIONS" \
LASTTY_BENCH_WARMUP="$BENCH_WARMUP" \
run_cmd ./target/release/lastty >/tmp/lastty-xterm-bench.log 2>&1 &
PID=$!

cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 300); do
  if [[ -f "$OUT_FILE" ]]; then
    wait "$PID" || true
    echo "Benchmark results written to $OUT_FILE"
    cat "$OUT_FILE"
    if ! node --input-type=module - "$OUT_FILE" <<'EOF'
import fs from "node:fs";

const outFile = process.argv[2];
const payload = JSON.parse(fs.readFileSync(outFile, "utf8"));

if (Array.isArray(payload) && payload.length > 0) {
  process.exit(0);
}

if (payload && typeof payload === "object" && typeof payload.error === "string") {
  console.error(`benchmark reported error: ${payload.error}`);
  process.exit(1);
}

console.error("benchmark output was not a non-empty result array");
process.exit(1);
EOF
    then
      exit 1
    fi
    exit 0
  fi
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    if wait "$PID"; then
      STATUS=0
    else
      STATUS=$?
    fi
    echo "Benchmark process exited before writing $OUT_FILE (status $STATUS)"
    echo "Tauri log:"
    tail -n 200 /tmp/lastty-xterm-bench.log || true
    exit 1
  fi
  sleep 1
done

echo "Timed out waiting for benchmark output"
echo "Tauri log:"
tail -n 200 /tmp/lastty-xterm-bench.log || true
exit 1
