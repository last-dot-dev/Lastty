#!/usr/bin/env node
// Prepares Rust sidecar binaries for Tauri's externalBin system.
// Tauri expects `src-tauri/binaries/<name>-<target-triple>`; cargo produces `target/release/<name>`.
// This script bridges the gap: build, then copy with the target-triple suffix.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const binariesDir = join(repoRoot, "src-tauri", "binaries");

const SIDECARS = ["lastty-mcp"];

function hostTargetTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("could not parse rustc -vV output for host triple");
  return line.split(":")[1].trim();
}

function cargoBuild(pkg) {
  const result = spawnSync(
    "cargo",
    ["build", "--release", "-p", pkg],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`cargo build failed for ${pkg} (exit ${result.status})`);
  }
}

function main() {
  const triple = hostTargetTriple();
  mkdirSync(binariesDir, { recursive: true });

  for (const name of SIDECARS) {
    cargoBuild(name);
    const src = join(repoRoot, "target", "release", name);
    if (!existsSync(src)) {
      throw new Error(`expected binary not found after build: ${src}`);
    }
    const dst = join(binariesDir, `${name}-${triple}`);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
    console.log(`  ${name} → ${dst}`);
  }
}

main();
