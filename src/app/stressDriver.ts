import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  createTerminal,
  finalizeStressBench,
  getBenchmarkMode,
  getStressBenchConfig,
  killTerminal,
  quitApp,
  registerStressSession,
  submitStressLifecycle,
  type StressBenchConfig,
  type TerminalFrameEvent,
} from "../lib/ipc";
import {
  activeDesktop,
  closePane,
  createPaneRecord,
  splitPane,
  type SplitDirection,
  type WorkspaceState,
} from "./layout";

const SETTLE_MS = 2000;

export interface StressDriverDeps {
  workspace: WorkspaceState | null;
  setWorkspace: React.Dispatch<React.SetStateAction<WorkspaceState | null>>;
  hydrated: boolean;
  hydrateSessionInfo: (sessionId: string, fallbackTitle: string) => Promise<void>;
}

export function useStressDriver(deps: StressDriverDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const startedRef = useRef(false);
  const tStartRef = useRef<number>(performance.now());
  const { hydrated } = deps;

  useEffect(() => {
    if (!__LASTTY_BENCH__) return;
    if (!hydrated || startedRef.current) return;

    let cancelled = false;
    startedRef.current = true;

    (async () => {
      const mode = await getBenchmarkMode().catch((err) => {
        console.error("stress: getBenchmarkMode failed", err);
        return null;
      });
      if (mode !== "stress" || cancelled) return;

      const cfg = await getStressBenchConfig();
      if (cancelled) return;

      await recordLifecycle("startup_to_hydrated_ms", performance.now() - tStartRef.current);
      await delay(SETTLE_MS);
      await recordLifecycle("settle_ms", SETTLE_MS);

      if (cancelled) return;
      await spawnPanes(cfg, depsRef.current);

      if (cancelled) return;
      await delay(cfg.duration_ms);

      try {
        await finalizeStressBench(cfg.output_path, cfg.duration_ms, cfg.panes);
      } catch (error) {
        console.error("finalize_stress_bench failed", error);
      }
      await quitApp().catch((err) => console.error("stress: quitApp failed", err));
    })().catch((error) => {
      console.error("stress driver crashed", error);
    });

    return () => {
      cancelled = true;
    };
  }, [hydrated]);
}

function recordLifecycle(stage: string, ms: number): Promise<void> {
  return submitStressLifecycle(stage, ms).catch((err) => {
    console.error(`stress: submitStressLifecycle(${stage}) failed`, err);
  });
}

async function spawnSimulatorPane(
  cfg: StressBenchConfig,
  scenario: string,
  cwd: string | undefined,
  hydrateSessionInfo: StressDriverDeps["hydrateSessionInfo"],
): Promise<string> {
  const spawnStart = performance.now();
  const sessionId = await createTerminal(cwd, "node", [cfg.simulator_path, scenario]);
  await registerStressSession(sessionId, scenario);
  void recordLifecycle("pane_spawn_ms", performance.now() - spawnStart);
  void waitForFirstFrame(sessionId).then((ms) => recordLifecycle("first_frame_ms", ms));
  await hydrateSessionInfo(sessionId, `stress-${scenario}`);
  return sessionId;
}

async function spawnPanes(
  cfg: StressBenchConfig,
  deps: StressDriverDeps,
): Promise<void> {
  const scenarios = expandScenarios(cfg.scenarios, cfg.panes);
  if (scenarios.length === 0) return;

  const initialPaneIds = deps.workspace ? Object.keys(deps.workspace.panes) : [];
  const initialSessionIds = deps.workspace
    ? initialPaneIds
        .map((id) => deps.workspace!.panes[id]?.sessionId)
        .filter((id): id is string => Boolean(id))
    : [];
  const cwd = activeCwd(deps.workspace);

  // The first stress pane replaces the bootstrap shell so we never render an
  // unused pane. Subsequent scenarios split off the first.
  const [firstScenario, ...restScenarios] = scenarios;
  const firstSessionId = await spawnSimulatorPane(
    cfg,
    firstScenario,
    cwd,
    deps.hydrateSessionInfo,
  );

  deps.setWorkspace((current) => {
    if (!current) return current;
    let next = current;
    for (const paneId of initialPaneIds) {
      next = closePane(next, paneId);
    }
    const desktop = activeDesktop(next);
    const firstRecord = createPaneRecord(firstSessionId, `stress-${firstScenario}`);
    if (!desktop.layout) {
      return {
        ...next,
        panes: { ...next.panes, [firstRecord.id]: firstRecord },
        desktops: next.desktops.map((entry) =>
          entry.id === desktop.id
            ? {
                ...entry,
                layout: { type: "leaf" as const, paneId: firstRecord.id },
                focusedPaneId: firstRecord.id,
              }
            : entry,
        ),
      };
    }
    const anchor = anchorPaneId(next);
    return anchor ? splitPane(next, anchor, "vertical", firstRecord) : next;
  });

  for (const sessionId of initialSessionIds) {
    void killTerminal(sessionId).catch((err) =>
      console.error("stress: killTerminal(bootstrap) failed", err),
    );
  }

  let direction: SplitDirection = "horizontal";
  for (const scenario of restScenarios) {
    const sessionId = await spawnSimulatorPane(cfg, scenario, cwd, deps.hydrateSessionInfo);
    const splitDirection = direction;
    direction = direction === "vertical" ? "horizontal" : "vertical";

    deps.setWorkspace((current) => {
      if (!current) return current;
      const anchor = anchorPaneId(current);
      if (!anchor) return current;
      return splitPane(
        current,
        anchor,
        splitDirection,
        createPaneRecord(sessionId, `stress-${scenario}`),
      );
    });
  }
}

function activeCwd(workspace: WorkspaceState | null): string | undefined {
  if (!workspace) return undefined;
  return activeDesktop(workspace).projectRoot || undefined;
}

function anchorPaneId(workspace: WorkspaceState): string | null {
  const desktop = activeDesktop(workspace);
  return desktop.focusedPaneId ?? Object.keys(workspace.panes)[0] ?? null;
}

function expandScenarios(scenarios: string[], panes: number): string[] {
  if (scenarios.length === 0 || panes === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < panes; i += 1) {
    out.push(scenarios[i % scenarios.length]);
  }
  return out;
}

function waitForFirstFrame(sessionId: string): Promise<number> {
  const start = performance.now();
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    const cleanup = () => unlisten?.();
    listen<TerminalFrameEvent>("term:frame", (event) => {
      if (event.payload.session_id !== sessionId) return;
      cleanup();
      resolve(performance.now() - start);
    }).then((stop) => {
      unlisten = stop;
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
