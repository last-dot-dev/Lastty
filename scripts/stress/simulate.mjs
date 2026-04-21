#!/usr/bin/env node
// Claude-Code-shaped output simulator for the stress bench.
// Runs one scenario to stdout until the parent PTY closes. Scenarios aim
// to cover the behaviors we most want to stress in the render pipeline:
// plain append, SGR churn, partial-damage rewrites, alt-screen redraws,
// and bursty traffic.
//
// Determinism: every scenario seeds an xorshift64 so two runs produce
// the same bytes — mirrors `src-tauri/src/bench_corpus.rs` so corpora
// stay comparable across backend/frontend benches.

const WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
  "elit", "sed", "eiusmod", "tempor", "incididunt", "labore", "magna",
  "aliqua", "enim", "minim", "veniam", "quis", "nostrud", "exercitation",
  "ullamco", "laboris", "nisi", "aliquip", "commodo", "consequat",
  "duis", "aute", "irure", "voluptate", "velit", "esse", "cillum",
  "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat",
];

function parseArgs(argv) {
  const args = { scenario: null, rate: null, seed: 0xa5a5a5a5 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--rate") args.rate = Number(argv[++i]);
    else if (value === "--seed") args.seed = Number(argv[++i]);
    else if (!args.scenario) args.scenario = value;
  }
  if (!args.scenario) {
    console.error(
      "usage: simulate.mjs <scenario> [--rate bytes_per_sec] [--seed n]",
    );
    process.exit(2);
  }
  return args;
}

function makeRng(seed) {
  let state = BigInt(seed | 1);
  const mask = (1n << 64n) - 1n;
  return {
    next() {
      let x = state;
      x = (x ^ (x << 13n)) & mask;
      x = (x ^ (x >> 7n)) & mask;
      x = (x ^ (x << 17n)) & mask;
      state = x;
      return Number(x & 0xffffffffn);
    },
    range(n) {
      return this.next() % n;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(bytes) {
  return new Promise((resolve) => {
    if (process.stdout.write(bytes)) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
    }
  });
}

function randomWords(rng, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(WORDS[rng.range(WORDS.length)]);
  }
  return out.join(" ");
}

async function streamingText({ rng, rate }) {
  // Steady word stream with \r\n breaks. Stresses plain append + parser.
  const targetBytesPerSec = rate ?? 5_000;
  const chunkMs = 50;
  const bytesPerChunk = Math.max(64, Math.floor(targetBytesPerSec * chunkMs / 1000));
  for (;;) {
    let buf = "";
    while (buf.length < bytesPerChunk) {
      buf += randomWords(rng, 6 + rng.range(8));
      buf += "\r\n";
    }
    await write(buf);
    await sleep(chunkMs);
  }
}

async function colorCycle({ rng, rate }) {
  // Truecolor SGR per cell in a full-line repaint. Stresses SGR parsing
  // and per-cell diff churn.
  const targetBytesPerSec = rate ?? 40_000;
  const chunkMs = 33;
  const lineCols = 80;
  for (;;) {
    let buf = "";
    let written = 0;
    const budget = Math.floor(targetBytesPerSec * chunkMs / 1000);
    while (written < budget) {
      for (let c = 0; c < lineCols; c += 1) {
        const r = rng.range(256);
        const g = rng.range(256);
        const b = rng.range(256);
        const ch = String.fromCharCode(65 + rng.range(26));
        buf += `\x1b[38;2;${r};${g};${b}m${ch}`;
      }
      buf += "\x1b[0m\r\n";
      written = buf.length;
    }
    await write(buf);
    await sleep(chunkMs);
  }
}

async function fade({ rate }) {
  // Same line, 24-bit color ramp dim->bright->dim. Lots of SGR-only diffs
  // with identical text content — tests how well we coalesce.
  const text = "streaming token consumption: ok | tokens/s 38.2 | ctx 72% | tools 4";
  const frameMs = 16;
  const _rate = rate; // accepted for API parity
  void _rate;
  let phase = 0;
  for (;;) {
    phase = (phase + 1) % 120;
    const t = phase < 60 ? phase / 60 : (120 - phase) / 60;
    const r = Math.round(60 + t * 195);
    const g = Math.round(60 + t * 195);
    const b = Math.round(90 + t * 165);
    const buf = `\r\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
    await write(buf);
    await sleep(frameMs);
  }
}

async function spinnerLog({ rng }) {
  // \r-rewriting spinner + interleaved log lines. Stresses the partial
  // damage path in particular (only a handful of cells change per frame).
  const frames = ["|", "/", "-", "\\"];
  let tick = 0;
  for (;;) {
    tick += 1;
    const frame = frames[tick % frames.length];
    await write(`\r\x1b[36m${frame}\x1b[0m thinking... (iter ${tick})`);
    if (tick % 8 === 0) {
      const level = tick % 16 === 0 ? "\x1b[33mWARN" : "\x1b[32mINFO";
      await write(`\r\x1b[2K${level}\x1b[0m ${randomWords(rng, 6)}\r\n`);
    }
    await sleep(50);
  }
}

async function altScreenRedraw({ rng }) {
  // vim-style full screen redraws via alt-screen enter/exit. Forces
  // `render_full` on the backend path every frame.
  const rows = 36;
  const cols = 100;
  for (;;) {
    let buf = "\x1b[?1049h\x1b[H";
    for (let r = 0; r < rows; r += 1) {
      buf += `\x1b[${r + 1};1H`;
      const color = [32, 36, 33, 37][rng.range(4)];
      buf += `\x1b[${color}m`;
      let line = "";
      while (line.length < cols - 4) {
        line += `${WORDS[rng.range(WORDS.length)]} `;
      }
      buf += line.slice(0, cols - 4);
      buf += "\x1b[0m";
    }
    buf += "\x1b[7m-- NORMAL --\x1b[0m\x1b[?1049l";
    await write(buf);
    await sleep(80);
  }
}

async function toolBurst({ rng }) {
  // Idle-then-blast pattern that models a claude-code tool result landing
  // after a pause. Tests mark coalescing and the frame-rate cap.
  for (;;) {
    await sleep(60);
    let buf = "\x1b[1m\x1b[36m[tool:bash]\x1b[0m running command...\r\n";
    for (let i = 0; i < 24; i += 1) {
      const r = rng.range(256);
      const g = rng.range(256);
      const b = rng.range(256);
      buf += `\x1b[38;2;${r};${g};${b}m  ‣ ${randomWords(rng, 10)}\x1b[0m\r\n`;
    }
    buf += "\x1b[32mdone.\x1b[0m\r\n";
    await write(buf);
  }
}

const SCENARIOS = {
  "streaming-text": streamingText,
  "color-cycle": colorCycle,
  "fade": fade,
  "spinner-log": spinnerLog,
  "alt-screen-redraw": altScreenRedraw,
  "tool-burst": toolBurst,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenario = SCENARIOS[args.scenario];
  if (!scenario) {
    console.error(
      `unknown scenario: ${args.scenario}. known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
    process.exit(2);
  }
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const rng = makeRng(args.seed);
  await scenario({ rng, rate: args.rate });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
