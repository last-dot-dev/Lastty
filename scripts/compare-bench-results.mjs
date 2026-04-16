#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [leftPath, rightPath] = process.argv.slice(2);
if (!leftPath || !rightPath) {
  console.error("usage: node ./scripts/compare-bench-results.mjs <baseline.json> <candidate.json>");
  process.exit(1);
}

const left = loadBench(leftPath);
const right = loadBench(rightPath);

console.log(`baseline: ${path.resolve(leftPath)}`);
console.log(`candidate: ${path.resolve(rightPath)}`);
console.log("");
console.log("key                                       baseline  candidate  delta%");
console.log("----------------------------------------  --------  ---------  ------");

for (const key of new Set([...left.keys(), ...right.keys()])) {
  const baseline = left.get(key);
  const candidate = right.get(key);
  if (!baseline || !candidate) {
    console.log(`${key.padEnd(40)}  ${fmt(baseline)}  ${fmt(candidate)}  ${"n/a".padStart(6)}`);
    continue;
  }
  const deltaPct = baseline === 0 ? 0 : ((candidate - baseline) / baseline) * 100;
  console.log(
    `${key.padEnd(40)}  ${fmt(baseline)}  ${fmt(candidate)}  ${deltaPct.toFixed(1).padStart(6)}`,
  );
}

function loadBench(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const map = new Map();
  if (!Array.isArray(payload)) return map;
  for (const row of payload) {
    const metric = row.p95Ms ?? row.p95_ms ?? row.meanMs ?? row.mean_ms;
    const key = `${row.renderer}:${row.workload ?? row.case}`;
    map.set(key, Number(metric));
  }
  return map;
}

function fmt(value) {
  return value === undefined ? "n/a".padStart(8) : value.toFixed(2).padStart(8);
}
