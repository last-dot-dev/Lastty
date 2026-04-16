/**
 * Pane agent SDK for Node.js / TypeScript.
 *
 * Usage:
 *   import { emit } from "./pane-sdk";
 *   emit("Ready", { agent: "my-agent", version: "1.0" });
 *   emit("Status", { phase: "thinking" });
 *   emit("Progress", { pct: 50, message: "Halfway there" });
 *   emit("Finished", { summary: "Done!", exit_code: 0 });
 */

export function emit(type: string, data: Record<string, unknown>): void {
  process.stdout.write(`\x1b]7770;${JSON.stringify({ type, data })}\x07`);
}
