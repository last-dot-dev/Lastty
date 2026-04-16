#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const outFile = path.join(
  os.tmpdir(),
  `lastty-xterm-bench-failure-${process.pid}-${Date.now()}.json`,
);
const failureMessage =
  process.env.LASTTY_BENCH_FORCE_FAILURE_MESSAGE ??
  "intentional xterm benchmark failure";

try {
  fs.rmSync(outFile, { force: true });
} catch {}

const child = spawn("./scripts/run-xterm-bench.sh", [outFile], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LASTTY_BENCH_FORCE_FAILURE: failureMessage,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const { code, signal } = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (exitCode, exitSignal) => {
    resolve({ code: exitCode, signal: exitSignal });
  });
});

if (signal) {
  console.error(`benchmark harness terminated by signal: ${signal}`);
  console.error(stdout.trimEnd());
  console.error(stderr.trimEnd());
  process.exit(1);
}

if (code === 0) {
  console.error("expected benchmark runner to fail, but it exited 0");
  console.error(stdout.trimEnd());
  console.error(stderr.trimEnd());
  process.exit(1);
}

if (!fs.existsSync(outFile)) {
  console.error(`expected benchmark output at ${outFile}`);
  console.error(stdout.trimEnd());
  console.error(stderr.trimEnd());
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(outFile, "utf8"));
if (!payload || typeof payload.error !== "string") {
  console.error(`expected an error payload in ${outFile}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

if (!payload.error.includes(failureMessage)) {
  console.error(`error payload did not include forced failure message: ${failureMessage}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(`verified failing xterm benchmark writes error artifact to ${outFile}`);
console.log(payload.error);
