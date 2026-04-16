import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { quitApp, writeBenchmarkReport } from "./lib/ipc";

type RendererMode = "dom" | "webgl";

interface BenchResult {
  renderer: RendererMode;
  workload: string;
  iterations: number;
  totalMs: number;
  meanMs: number;
}

const COLS = 221;
const ROWS = 61;
const ITERATIONS = 20;
const OUTPUT_PATH = "/tmp/lastty-xterm-bench.json";

export default function XtermBench() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("initializing");
  const workloads = useMemo(
    () => [
      { name: "uniform_full_redraw", frame: makeUniformFrame() },
      { name: "mixed_full_redraw", frame: makeMixedFrame() },
      { name: "dense_logs_full_redraw", frame: makeLogsFrame() },
      { name: "unicode_color_full_redraw", frame: makeUnicodeFrame() },
    ],
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!hostRef.current) return;
      const results: BenchResult[] = [];

      for (const renderer of ["dom", "webgl"] as RendererMode[]) {
        const term = new Terminal({
          cols: COLS,
          rows: ROWS,
          scrollback: 0,
          allowProposedApi: true,
          fontFamily: "Menlo, Monaco, monospace",
          fontSize: 14,
        });

        let webglAddon: WebglAddon | null = null;
        if (renderer === "webgl") {
          webglAddon = new WebglAddon();
          term.loadAddon(webglAddon);
        }

        hostRef.current.innerHTML = "";
        term.open(hostRef.current);
        await nextFrame();

        for (const workload of workloads) {
          setStatus(`running ${renderer} ${workload.name}`);
          const totalMs = await measureWrite(term, workload.frame, ITERATIONS);
          results.push({
            renderer,
            workload: workload.name,
            iterations: ITERATIONS,
            totalMs,
            meanMs: totalMs / ITERATIONS,
          });
        }

        webglAddon?.dispose();
        term.dispose();
      }

      if (cancelled) return;

      setStatus(`writing ${OUTPUT_PATH}`);
      await writeBenchmarkReport(OUTPUT_PATH, JSON.stringify(results, null, 2));
      setStatus("complete");
      await quitApp();
    }

    run().catch(async (error) => {
      const message =
        error instanceof Error ? error.stack || error.message : String(error);
      setStatus(`failed: ${message}`);
      await writeBenchmarkReport(
        OUTPUT_PATH,
        JSON.stringify({ error: message }, null, 2),
      ).catch(() => {});
      await quitApp().catch(() => {});
    });

    return () => {
      cancelled = true;
    };
  }, [workloads]);

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

async function measureWrite(
  term: Terminal,
  frame: string,
  iterations: number,
): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    await new Promise<void>((resolve) => {
      term.write(frame, () => resolve());
    });
  }
  return performance.now() - start;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function makeUniformFrame() {
  const rows = Array.from({ length: ROWS }, (_, i) =>
    `${"\u001b[0m\u001b[38;2;220;220;220m"}file_${String(i).padStart(3, "0")}.rs Cargo.toml README.md src target scripts docs`,
  );
  return `\u001b[H\u001b[2J${rows.join("\r\n")}\u001b[0m`;
}

function makeMixedFrame() {
  const rows = Array.from({ length: ROWS }, (_, i) => {
    return [
      "\u001b[0m\u001b[38;2;180;180;180m@@ ",
      `-${i + 1},4 +${i + 1},4 `,
      "\u001b[38;2;255;90;90m-old_value() ",
      "\u001b[38;2;90;220;120m\u001b[1m+new_value()",
    ].join("");
  });
  return `\u001b[H\u001b[2J${rows.join("\r\n")}\u001b[0m`;
}

function makeLogsFrame() {
  const rows = Array.from({ length: ROWS }, (_, i) => {
    return [
      `\u001b[38;2;140;180;255m2026-04-16T06:${String(i % 60).padStart(2, "0")}:12.123Z `,
      "\u001b[38;2;120;220;180m\u001b[1mINFO ",
      "\u001b[38;2;220;220;220mcompiler.pipeline: finished chunk render and flushed viewport cache",
    ].join("");
  });
  return `\u001b[H\u001b[2J${rows.join("\r\n")}\u001b[0m`;
}

function makeUnicodeFrame() {
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const palette = i % 3;
    const color =
      palette === 0 ? "255;160;90" : palette === 1 ? "120;220;255" : "180;255;140";
    return `\u001b[38;2;${color}mλ render ✓ café 👩‍💻 日本語 résumé naïve — row ${i}`;
  });
  return `\u001b[H\u001b[2J${rows.join("\r\n")}\u001b[0m`;
}
