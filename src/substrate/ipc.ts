import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AppId, DocPatch, HistoryEntry, SpawnedApp } from "./types";

export async function spawnSeed(kind: string): Promise<SpawnedApp> {
  return invoke<SpawnedApp>("substrate_spawn_seed", { kind });
}

export async function spawnGenerative(prompt: string): Promise<SpawnedApp> {
  return invoke<SpawnedApp>("substrate_spawn_generative", { prompt });
}

export async function forkApp(source: AppId): Promise<SpawnedApp> {
  return invoke<SpawnedApp>("substrate_fork", { source });
}

export async function materialize(appId: AppId): Promise<unknown> {
  return invoke<unknown>("substrate_materialize", { appId });
}

export async function sendIntent(
  target: AppId,
  verb: string,
  payload: unknown,
): Promise<void> {
  return invoke<void>("substrate_send_intent", { target, verb, payload });
}

export async function subscribe(
  appId: AppId,
  onPatch: (p: DocPatch) => void,
): Promise<UnlistenFn> {
  await invoke<string>("substrate_subscribe", { target: appId });
  return listen<DocPatch>(`substrate:patch:${appId}`, (e) => onPatch(e.payload));
}

export async function appHistory(appId: AppId): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("substrate_history", { appId });
}

export async function materializeAt(
  appId: AppId,
  heads: string[],
): Promise<unknown> {
  return invoke<unknown>("substrate_materialize_at", { appId, heads });
}
