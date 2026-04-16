#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const benchPath = process.argv[2] || "/tmp/lastty-xterm-bench.json";

if (!fs.existsSync(benchPath)) {
  console.error(`benchmark file not found: ${benchPath}`);
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(benchPath, "utf8"));
if (!Array.isArray(results) || results.length === 0) {
  console.error(`benchmark file is empty or invalid: ${benchPath}`);
  process.exit(1);
}

console.log(`xterm benchmark: ${path.resolve(benchPath)}`);
console.log("");
console.log("renderer  workload                  frames  mean_ms  p50_ms  p95_ms  max_ms");
console.log("--------  ------------------------  ------  -------  ------  ------  ------");
for (const row of results) {
  console.log(
    `${String(row.renderer).padEnd(8)}  ${String(row.workload).padEnd(24)}  ${String(row.frameCount ?? "?").padStart(6)}  ${format(row.meanMs).padStart(7)}  ${format(row.p50Ms).padStart(6)}  ${format(row.p95Ms).padStart(6)}  ${format(row.maxMs).padStart(6)}`,
  );
}

const grouped = new Map();
for (const row of results) {
  const current = grouped.get(row.renderer) ?? { mean: 0, p95: 0, count: 0 };
  current.mean += Number(row.meanMs ?? 0);
  current.p95 += Number(row.p95Ms ?? 0);
  current.count += 1;
  grouped.set(row.renderer, current);
}

console.log("");
console.log("renderer summary");
for (const [renderer, stats] of grouped) {
  console.log(
    `${renderer}: avg mean ${format(stats.mean / stats.count)}ms, avg p95 ${format(
      stats.p95 / stats.count,
    )}ms across ${stats.count} workloads`,
  );
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}
