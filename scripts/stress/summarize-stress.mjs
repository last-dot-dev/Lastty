#!/usr/bin/env node
// Reads the JSON report written by `finalize_stress_bench` and prints a
// per-session table plus a hotspots ranking. Designed to be safe to run
// in a loop — exits 1 only if the input file is missing or malformed.

import fs from "node:fs";

const path = process.argv[2] || "/tmp/lastty-stress.json";
if (!fs.existsSync(path)) {
  console.error(`stress report not found: ${path}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(path, "utf8"));
if (!report || !Array.isArray(report.sessions)) {
  console.error(`stress report at ${path} is malformed`);
  process.exit(1);
}

const durationS = (report.duration_ms ?? 0) / 1000;
console.log(
  `duration: ${durationS}s   panes: ${report.panes ?? report.sessions.length}   total emits: ${report.aggregate?.total_emits ?? "?"}   total marks: ${report.aggregate?.total_marks ?? "?"}`,
);
console.log("");

if (report.lifecycle && Object.keys(report.lifecycle).length > 0) {
  console.log("Lifecycle (one-shot startup + per-pane spawn timings):");
  for (const stage of Object.keys(report.lifecycle).sort()) {
    const s = report.lifecycle[stage];
    if (!s || s.samples === 0) continue;
    console.log(
      `  ${stage.padEnd(24)} samples=${String(s.samples).padStart(3)}  avg=${fmt(s.avg, 1)}ms  p50=${fmt(s.p50, 1)}ms  p95=${fmt(s.p95, 1)}ms  max=${fmt(s.max, 1)}ms`,
    );
  }
  console.log("");
}

const headers = [
  ["session", 14],
  ["scenario", 18],
  ["marks", 8],
  ["emits", 8],
  ["coalesce", 9],
  ["render p95 us", 14],
  ["emit p95 us", 12],
  ["m2e p95 us", 11],
  ["write p95 ms", 13],
];
console.log(headers.map(([h, w]) => h.padEnd(w)).join(" "));
console.log(headers.map(([, w]) => "-".repeat(w)).join(" "));
for (const session of report.sessions) {
  const row = [
    truncate(session.session_id, 14),
    truncate(session.scenario ?? "?", 18),
    String(session.marks),
    String(session.emits),
    fmt(session.coalesce_ratio, 2),
    fmt(session.render_us?.p95, 0),
    fmt(session.emit_us?.p95, 0),
    fmt(session.mark_to_emit_us?.p95, 0),
    fmt(session.frontend_write_ms?.p95, 2),
  ];
  console.log(row.map((v, i) => v.padEnd(headers[i][1])).join(" "));
}
console.log("");

if (Array.isArray(report.hotspots) && report.hotspots.length > 0) {
  console.log("Top hotspots (by p95 × emits, summed wall ms):");
  for (const [i, h] of report.hotspots.entries()) {
    const scenario = h.scenario ?? "?";
    const session = truncate(h.session_id, 8);
    const total = `${h.total_ms.toFixed(1)}ms`;
    const share = `${h.share_of_total_pct.toFixed(1)}%`;
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${scenario.padEnd(18)} ${h.stage.padEnd(18)} ${total.padStart(10)}  (${share} of total)  [${session}]`,
    );
  }
  console.log("");
}

const agg = report.aggregate;
if (agg) {
  console.log("Aggregate:");
  console.log(
    `  render_us         p50=${fmt(agg.render_us?.p50, 0)} p95=${fmt(agg.render_us?.p95, 0)} max=${fmt(agg.render_us?.max, 0)}`,
  );
  console.log(
    `  emit_us           p50=${fmt(agg.emit_us?.p50, 0)} p95=${fmt(agg.emit_us?.p95, 0)} max=${fmt(agg.emit_us?.max, 0)}`,
  );
  console.log(
    `  mark_to_emit_us   p50=${fmt(agg.mark_to_emit_us?.p50, 0)} p95=${fmt(agg.mark_to_emit_us?.p95, 0)} max=${fmt(agg.mark_to_emit_us?.max, 0)}`,
  );
  console.log(
    `  frontend_write_ms p50=${fmt(agg.frontend_write_ms?.p50, 2)} p95=${fmt(agg.frontend_write_ms?.p95, 2)} max=${fmt(agg.frontend_write_ms?.max, 2)}`,
  );
  console.log(
    `  ansi_bytes        p50=${fmt(agg.ansi_bytes?.p50, 0)} p95=${fmt(agg.ansi_bytes?.p95, 0)} max=${fmt(agg.ansi_bytes?.max, 0)}`,
  );
}

function fmt(value, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function truncate(value, width) {
  const text = String(value ?? "");
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
