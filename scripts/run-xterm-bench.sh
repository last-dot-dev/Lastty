#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_FILE="${1:-/tmp/lastty-xterm-bench.json}"
rm -f "$OUT_FILE"

echo "Building frontend..."
pnpm build >/tmp/lastty-xterm-bench-build.log 2>&1

echo "Running xterm benchmark in Tauri..."
LASTTY_BENCH_MODE=xterm cargo run -p lastty --release --bin lastty >/tmp/lastty-xterm-bench.log 2>&1 &
PID=$!

cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 300); do
  if [[ -f "$OUT_FILE" ]]; then
    echo "Benchmark results written to $OUT_FILE"
    cat "$OUT_FILE"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for benchmark output"
echo "Tauri log:"
tail -n 200 /tmp/lastty-xterm-bench.log || true
exit 1
