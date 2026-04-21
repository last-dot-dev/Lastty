import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
// LASTTY_BENCH=1 swaps in a build-time constant `__LASTTY_BENCH__` so all
// bench-only modules (XtermBench, stressDriver, related IPC calls) get
// tree-shaken out of the default release bundle.
const benchEnabled = process.env.LASTTY_BENCH === "1";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __LASTTY_BENCH__: JSON.stringify(benchEnabled),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.pane-worktrees/**"],
    },
  },
});
