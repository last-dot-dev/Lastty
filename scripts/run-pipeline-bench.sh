#!/usr/bin/env bash
# L2 pipeline bench runner. Builds in release, then either runs all workloads
# or a single one if --workload is passed through.
set -euo pipefail

cd "$(dirname "$0")/.."

cargo build -p bench-harness --release --bin bench_pipeline >/dev/null

OUT="${OUT:-/tmp/lastty-bench-pipeline.json}"
exec ./target/release/bench_pipeline --output "$OUT" "$@"
