#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const newVersion = process.argv[2];
if (!newVersion) {
  console.error("Usage: bump-version.mjs <new-version>");
  process.exit(1);
}
if (!SEMVER.test(newVersion)) {
  console.error(`Invalid version "${newVersion}". Expected X.Y.Z or X.Y.Z-prerelease.`);
  process.exit(1);
}

function bumpJson(relPath, key) {
  const path = resolve(repoRoot, relPath);
  const src = readFileSync(path, "utf8");
  const re = new RegExp(`("${key}"\\s*:\\s*")([^"]+)(")`);
  const match = src.match(re);
  if (!match) throw new Error(`${relPath}: no "${key}" field found`);
  const current = match[2];
  const next = src.replace(re, `$1${newVersion}$3`);
  writeFileSync(path, next);
  return current;
}

// Only replaces version inside the [package] block so workspace/dependency
// versions aren't touched.
function bumpCargoToml(relPath) {
  const path = resolve(repoRoot, relPath);
  const src = readFileSync(path, "utf8");
  const re = /(\[package\][^\[]*?\nversion\s*=\s*")([^"]+)(")/;
  const match = src.match(re);
  if (!match) throw new Error(`${relPath}: no [package] version field found`);
  const current = match[2];
  const next = src.replace(re, `$1${newVersion}$3`);
  writeFileSync(path, next);
  return current;
}

const changes = [
  { file: "package.json", from: bumpJson("package.json", "version") },
  { file: "src-tauri/Cargo.toml", from: bumpCargoToml("src-tauri/Cargo.toml") },
  { file: "src-tauri/tauri.conf.json", from: bumpJson("src-tauri/tauri.conf.json", "version") },
  { file: "pane-protocol/Cargo.toml", from: bumpCargoToml("pane-protocol/Cargo.toml") },
  { file: "bench-harness/Cargo.toml", from: bumpCargoToml("bench-harness/Cargo.toml") },
];

for (const { file, from } of changes) {
  console.log(`${file}: ${from} -> ${newVersion}`);
}

console.log("\nRefreshing Cargo.lock...");
const cargo = spawnSync(
  "cargo",
  ["update", "-p", "lastty", "-p", "pane-protocol", "-p", "bench-harness"],
  { cwd: repoRoot, stdio: "inherit" },
);
if (cargo.status !== 0) {
  console.error("cargo update failed");
  process.exit(cargo.status ?? 1);
}

console.log(`\nBumped to ${newVersion}. Review the diff and commit when ready.`);
