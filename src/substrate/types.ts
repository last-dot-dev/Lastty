export type AppId = string;
export type SubscriptionId = string;

export type ChartKind = "bar" | "line";

export type Binding =
  | string
  | { path: string; fallback?: string | null };

export type ViewNode =
  | { kind: "stack"; children: ViewNode[]; gap?: number }
  | { kind: "row"; children: ViewNode[]; gap?: number }
  | { kind: "text"; binding: Binding }
  | { kind: "list"; items_path: string; item: ViewNode }
  | { kind: "card"; title: Binding; body: ViewNode }
  | { kind: "progress"; value_path: string; max: number }
  | {
      kind: "button";
      label: string;
      intent_verb: string;
      intent_payload?: unknown;
    }
  | { kind: "text_input"; value_path: string; placeholder?: string | null }
  | { kind: "image"; src_path: string }
  | { kind: "chart"; series_path: string; chart_kind: ChartKind };

export interface ViewSpec {
  root: ViewNode;
}

export interface SpawnedApp {
  id: AppId;
  kind: string;
  view: ViewSpec;
  doc: unknown;
}

export type DocPatch =
  | { op: "put"; path: string[]; value: unknown }
  | { op: "insert"; path: string[]; index: number; value: unknown }
  | { op: "delete"; path: string[] };

export interface HistoryEntry {
  hash: string;
  ts: number;
  actor: string;
  message: string;
}
