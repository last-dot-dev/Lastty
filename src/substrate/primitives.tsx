import { sendIntent } from "./ipc";
import type { AppId, Binding, ViewNode } from "./types";

export function resolveBinding(doc: unknown, binding: Binding): string {
  if (typeof binding === "string") return binding;
  const value = resolvePath(doc, binding.path);
  if (value === undefined || value === null) return binding.fallback ?? "";
  return String(value);
}

export function resolvePath(doc: unknown, path: string): unknown {
  if (!path) return doc;
  const parts = path.split(".");
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

interface RenderContext {
  appId: AppId;
  onDragItem?: (listPath: string, item: unknown) => void;
  dropTargetListPath?: string;
}

export function RenderNode({
  node,
  doc,
  ctx,
}: {
  node: ViewNode;
  doc: unknown;
  ctx: RenderContext;
}) {
  switch (node.kind) {
    case "stack":
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: node.gap ?? 8,
          }}
        >
          {node.children.map((c, i) => (
            <RenderNode key={i} node={c} doc={doc} ctx={ctx} />
          ))}
        </div>
      );
    case "row":
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: node.gap ?? 8,
            alignItems: "center",
          }}
        >
          {node.children.map((c, i) => (
            <RenderNode key={i} node={c} doc={doc} ctx={ctx} />
          ))}
        </div>
      );
    case "text":
      return <span>{resolveBinding(doc, node.binding)}</span>;
    case "list": {
      const items =
        (resolvePath(doc, node.items_path) as unknown[] | undefined) ?? [];
      return (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
          data-list-path={node.items_path}
        >
          {items.map((item, i) => (
            <div
              key={i}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-substrate-node",
                  JSON.stringify({
                    sourceAppId: ctx.appId,
                    listPath: node.items_path,
                    item,
                  }),
                );
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              style={{
                cursor: "grab",
                padding: 6,
                background: "rgba(255,255,255,0.04)",
                borderRadius: 4,
              }}
            >
              <RenderNode node={node.item} doc={item} ctx={ctx} />
            </div>
          ))}
        </div>
      );
    }
    case "card":
      return (
        <div
          style={{
            border: "1px solid #2a2a2a",
            borderRadius: 8,
            padding: 12,
            background: "#0f0f10",
          }}
          onDragOver={(e) => {
            if (
              e.dataTransfer.types.includes("application/x-substrate-node")
            ) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(
              "application/x-substrate-node",
            );
            if (!raw) return;
            try {
              const parsed = JSON.parse(raw) as {
                listPath: string;
                item: unknown;
              };
              void sendIntent(ctx.appId, "merge_node", {
                list_path: parsed.listPath,
                item: parsed.item,
              });
            } catch {
              /* ignore */
            }
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
            {resolveBinding(doc, node.title)}
          </div>
          <RenderNode node={node.body} doc={doc} ctx={ctx} />
        </div>
      );
    case "progress": {
      const v = Number(resolvePath(doc, node.value_path) ?? 0);
      const pct = Math.min(100, Math.max(0, (v / node.max) * 100));
      return (
        <div
          title={`${v} / ${node.max}`}
          style={{
            height: 6,
            background: "#1c1c1e",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "#6cf",
              borderRadius: 3,
              transition: "width 120ms ease",
            }}
          />
        </div>
      );
    }
    case "button":
      return (
        <button
          style={{
            padding: "4px 10px",
            background: "#1a1a1c",
            color: "#ddd",
            border: "1px solid #333",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
          }}
          onClick={() =>
            void sendIntent(
              ctx.appId,
              node.intent_verb,
              node.intent_payload ?? {},
            )
          }
        >
          {node.label}
        </button>
      );
    case "text_input":
      return (
        <input
          placeholder={node.placeholder ?? undefined}
          defaultValue={String(resolvePath(doc, node.value_path) ?? "")}
          onBlur={(e) =>
            void sendIntent(ctx.appId, "set_field", {
              path: node.value_path,
              value: e.target.value,
            })
          }
          style={{
            background: "#111",
            color: "#ddd",
            border: "1px solid #333",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 12,
          }}
        />
      );
    case "image":
      return (
        <img
          src={String(resolvePath(doc, node.src_path) ?? "")}
          alt=""
          style={{ maxWidth: "100%", borderRadius: 4 }}
        />
      );
    case "chart": {
      const series =
        (resolvePath(doc, node.series_path) as
          | Array<Record<string, unknown>>
          | undefined) ?? [];
      const values = series.map((s) => Number(s.cost ?? s.value ?? 0));
      const maxV = Math.max(1, ...values);
      return (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 4,
            height: 36,
          }}
        >
          {values.map((v, i) => (
            <div
              key={i}
              title={String(v)}
              style={{
                width: 10,
                height: `${Math.max(2, (v / maxV) * 100)}%`,
                background: "#6cf",
                opacity: 0.8,
                borderRadius: 2,
              }}
            />
          ))}
        </div>
      );
    }
  }
}
