#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const tracePath = process.argv[2] || "/tmp/lastty-perf.jsonl";

if (!fs.existsSync(tracePath)) {
  console.error(`trace file not found: ${tracePath}`);
  process.exit(1);
}

const lines = fs
  .readFileSync(tracePath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (lines.length === 0) {
  console.error(`trace file is empty: ${tracePath}`);
  process.exit(1);
}

const samples = lines.map((line, idx) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid JSON on line ${idx + 1}: ${error.message}`);
  }
});

const metrics = [
  "snapshot_ms",
  "render_ms",
  "frame_ms",
  "cache_ms",
  "rect_ms",
  "prepare_ms",
  "gpu_ms",
  "fps",
  "changed_lines",
  "cached_lines",
  "text_areas",
  "wakeups",
  "pending_updates",
];

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

const summary = metrics.map((metric) => {
  const values = samples
    .map((sample) => sample[metric])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;

  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    metric,
    count: values.length,
    avg: total / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}).filter(Boolean);

const header = [
  `trace: ${path.resolve(tracePath)}`,
  `samples: ${samples.length}`,
  `time_span_ms: ${samples.at(-1)?.ts_ms ?? 0}`,
];

console.log(header.join("\n"));
console.log("");
console.log("metric           avg      p50      p95      max");
console.log("---------------  -------  -------  -------  -------");
for (const row of summary) {
  console.log(
    `${row.metric.padEnd(15)}  ${formatNumber(row.avg).padStart(7)}  ${formatNumber(row.p50).padStart(7)}  ${formatNumber(row.p95).padStart(7)}  ${formatNumber(row.max).padStart(7)}`,
  );
}
