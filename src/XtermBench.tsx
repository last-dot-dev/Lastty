import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import {
  getBenchmarkConfig,
  getFontConfig,
  quitApp,
  writeBenchmarkReport,
} from "./lib/ipc";

type RendererMode = "dom";

interface BenchResult {
  renderer: RendererMode;
  workload: string;
  cols: number;
  rows: number;
  frameCount: number;
  iterations: number;
  warmupIterations: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface BenchConfig {
  cols: number;
  rows: number;
  iterations: number;
  warmupIterations: number;
  outputPath: string;
  forceFailureMessage?: string | null;
}

interface Workload {
  name: string;
  frames: string[];
}

export default function XtermBench() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const configRef = useRef<BenchConfig | null>(null);
  const [status, setStatus] = useState("initializing");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!hostRef.current) return;
      const rawConfig = await getBenchmarkConfig();
      const config: BenchConfig = {
        cols: rawConfig.cols,
        rows: rawConfig.rows,
        iterations: rawConfig.iterations,
        warmupIterations: rawConfig.warmup_iterations,
        outputPath: rawConfig.output_path,
        forceFailureMessage: rawConfig.force_failure_message,
      };
      configRef.current = config;
      if (config.forceFailureMessage) {
        setStatus(`failing: ${config.forceFailureMessage}`);
        throw new Error(config.forceFailureMessage);
      }
      const font = await getFontConfig();
      const workloads = buildWorkloads(config.cols, config.rows);
      const results: BenchResult[] = [];

      const renderer: RendererMode = "dom";
      const term = new Terminal({
        cols: config.cols,
        rows: config.rows,
        scrollback: 0,
        allowProposedApi: true,
        fontFamily: `${font.family}, NFFallback, Monaco, monospace`,
        fontSize: font.size_px,
        lineHeight: font.line_height,
      });

      hostRef.current.innerHTML = "";
      term.open(hostRef.current);
      await nextFrame();

      for (const workload of workloads) {
        setStatus(`warming ${renderer} ${workload.name}`);
        await warmup(term, workload.frames, config.warmupIterations);

        setStatus(`running ${renderer} ${workload.name}`);
        const samples = await measureFrames(term, workload.frames, config.iterations);
        const totalMs = samples.reduce((sum, value) => sum + value, 0);
        results.push({
          renderer,
          workload: workload.name,
          cols: config.cols,
          rows: config.rows,
          frameCount: workload.frames.length,
          iterations: config.iterations,
          warmupIterations: config.warmupIterations,
          totalMs,
          meanMs: totalMs / samples.length,
          p50Ms: percentile(samples, 50),
          p95Ms: percentile(samples, 95),
          maxMs: Math.max(...samples),
        });
      }

      term.dispose();

      if (cancelled) return;

      setStatus(`writing ${config.outputPath}`);
      await writeBenchmarkReport(config.outputPath, JSON.stringify(results, null, 2));
      setStatus("complete");
      await quitApp();
    }

    run().catch(async (error) => {
      const message = formatError(error);
      setStatus(`failed: ${message}`);
      const outputPath = configRef.current?.outputPath ?? "/tmp/lastty-xterm-bench.json";
      await writeBenchmarkReport(
        outputPath,
        JSON.stringify({ error: message }, null, 2),
      ).catch(() => {});
      await quitApp().catch(() => {});
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#111",
        color: "#ddd",
        display: "grid",
        gridTemplateRows: "auto 1fr",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          fontFamily: "monospace",
          fontSize: 12,
          borderBottom: "1px solid #333",
        }}
      >
        {status}
      </div>
      <div ref={hostRef} style={{ overflow: "hidden" }} />
    </div>
  );
}

async function warmup(term: Terminal, frames: string[], iterations: number) {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const frame of frames) {
      await writeFrame(term, frame);
    }
  }
}

async function measureFrames(
  term: Terminal,
  frames: string[],
  iterations: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const frame of frames) {
      const startedAt = performance.now();
      await writeFrame(term, frame);
      samples.push(performance.now() - startedAt);
    }
  }
  return samples;
}

function writeFrame(term: Terminal, frame: string) {
  return new Promise<void>((resolve) => {
    term.write(frame, () => resolve());
  });
}

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    if (error.stack && error.stack.includes(error.message)) {
      return error.stack;
    }
    return error.message
      ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : error.stack || String(error);
  }
  return String(error);
}

function buildWorkloads(cols: number, rows: number): Workload[] {
  return [
    { name: "uniform_full_redraw", frames: [makeUniformFrame(cols, rows)] },
    { name: "mixed_full_redraw", frames: [makeMixedFrame(cols, rows)] },
    { name: "dense_logs_full_redraw", frames: [makeLogsFrame(cols, rows)] },
    { name: "unicode_color_full_redraw", frames: [makeUnicodeFrame(cols, rows)] },
    { name: "append_burst", frames: makeAppendBurstFrames(cols, rows) },
    { name: "scroll_like_shift", frames: makeScrollFrames(cols, rows) },
  ];
}

function makeUniformFrame(cols: number, rows: number) {
  const rowText = `file_000.rs Cargo.toml README.md src target scripts benches docs`.padEnd(
    cols,
    " ",
  );
  const lines = Array.from({ length: rows }, (_, index) =>
    `\u001b[0m\u001b[38;2;220;220;220m${rowText.replace("000", String(index).padStart(3, "0"))}`,
  );
  return `\u001b[H\u001b[2J${lines.join("\r\n")}\u001b[0m`;
}

function makeMixedFrame(cols: number, rows: number) {
  const lines = Array.from({ length: rows }, (_, index) =>
    [
      "\u001b[0m\u001b[38;2;180;180;180m@@ ",
      `-${index + 1},4 +${index + 1},4 `.padEnd(Math.max(0, cols - 24), " "),
      "\u001b[38;2;255;90;90m-old_value() ",
      "\u001b[38;2;90;220;120m\u001b[1m+new_value()",
    ].join(""),
  );
  return `\u001b[H\u001b[2J${lines.join("\r\n")}\u001b[0m`;
}

function makeLogsFrame(cols: number, rows: number) {
  const message =
    "compiler.pipeline: finished chunk render and flushed viewport cache";
  const lines = Array.from({ length: rows }, (_, index) =>
    [
      `\u001b[38;2;140;180;255m2026-04-16T06:${String(index % 60).padStart(2, "0")}:12.123Z `,
      "\u001b[38;2;120;220;180m\u001b[1mINFO ",
      `\u001b[38;2;220;220;220m${message.slice(0, Math.max(0, cols - 31))}`,
    ].join(""),
  );
  return `\u001b[H\u001b[2J${lines.join("\r\n")}\u001b[0m`;
}

function makeUnicodeFrame(cols: number, rows: number) {
  const lines = Array.from({ length: rows }, (_, index) => {
    const palette = index % 3;
    const color =
      palette === 0 ? "255;160;90" : palette === 1 ? "120;220;255" : "180;255;140";
    return `\u001b[38;2;${color}m${`λ render ✓ café 👩‍💻 日本語 résumé naïve row ${index}`.slice(
      0,
      cols,
    )}`;
  });
  return `\u001b[H\u001b[2J${lines.join("\r\n")}\u001b[0m`;
}

function makeAppendBurstFrames(cols: number, rows: number) {
  const frames: string[] = [];
  for (let frameIndex = 0; frameIndex < 12; frameIndex += 1) {
    const lines = Array.from({ length: rows }, (_, rowIndex) => {
      const absoluteIndex = Math.max(0, frameIndex - rows + rowIndex + 1);
      if (absoluteIndex <= 0) return "";
      return [
        `\u001b[38;2;140;180;255m2026-04-16T07:${String(absoluteIndex % 60).padStart(2, "0")}:45.500Z `,
        "\u001b[38;2;120;220;180mINFO ",
        `\u001b[38;2;220;220;220mappend burst line ${absoluteIndex}`.slice(0, cols),
      ].join("");
    });
    frames.push(`\u001b[H\u001b[2J${lines.join("\r\n")}\u001b[0m`);
  }
  return frames;
}

function makeScrollFrames(cols: number, rows: number) {
  const corpus = Array.from({ length: rows + 10 }, (_, index) =>
    `\u001b[38;2;220;220;220mline ${String(index).padStart(3, "0")} cargo test --color=always ${".".repeat(
      Math.max(0, cols - 36),
    )}`,
  );

  return Array.from({ length: 10 }, (_, offset) => {
    const lines = corpus.slice(offset, offset + rows);
    return `\u001b[H\u001b[2J${lines.join("\r\n")}\u001b[0m`;
  });
}
