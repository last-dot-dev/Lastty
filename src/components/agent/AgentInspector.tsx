import type { CSSProperties, ReactNode } from "react";
import type { AgentSessionState, ToolCallRecord } from "../../app/agentUi";

export function AgentInspector({ agent }: { agent: AgentSessionState }) {
  const latestWidget = agent.widgets.at(-1);
  return (
    <aside
      style={{
        borderLeft: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-secondary)",
        color: "var(--color-text-primary)",
        padding: 12,
        overflow: "auto",
        display: "grid",
        gap: 12,
      }}
    >
      <InspectorBlock label="Status">
        <div>{agent.status?.phase ?? "idle"}</div>
        {agent.status?.detail && (
          <div style={{ color: "var(--color-text-secondary)" }}>{agent.status.detail}</div>
        )}
        {agent.progress && (
          <div>
            {agent.progress.pct}% · {agent.progress.message}
          </div>
        )}
      </InspectorBlock>
      {agent.toolCallOrder.length > 0 && (
        <InspectorBlock label="Tool Calls">
          {agent.rootToolCallIds.map((id) => (
            <ToolCallNode
              key={id}
              id={id}
              toolCallsById={agent.toolCallsById}
              childrenByParentId={agent.childrenByParentId}
            />
          ))}
        </InspectorBlock>
      )}
      {agent.fileEdits.length > 0 && (
        <InspectorBlock label="Files Changed">
          {agent.fileEdits.slice(-6).map((file) => (
            <div key={`${file.kind}-${file.path}`}>
              {file.kind.toUpperCase()} {file.path}
            </div>
          ))}
        </InspectorBlock>
      )}
      {latestWidget && (
        <InspectorBlock label={`Widget · ${latestWidget.widgetType}`}>
          <WidgetRenderer widgetType={latestWidget.widgetType} props={latestWidget.props} />
        </InspectorBlock>
      )}
    </aside>
  );
}

function ToolCallNode({
  id,
  toolCallsById,
  childrenByParentId,
}: {
  id: string;
  toolCallsById: Record<string, ToolCallRecord>;
  childrenByParentId: Record<string, string[]>;
}) {
  const call = toolCallsById[id];
  if (!call) return null;
  const children = childrenByParentId[id] ?? [];
  const isSubagent = call.name === "Agent" || call.name === "Task";
  return (
    <div
      style={{
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        paddingBottom: 6,
        paddingLeft: call.depth > 0 ? 10 : 0,
        borderLeft:
          call.depth > 0 ? "1px solid var(--color-border-tertiary)" : undefined,
        marginLeft: call.depth > 0 ? call.depth * 8 : 0,
      }}
    >
      <div>
        {call.depth > 0 && (
          <span style={{ color: "var(--color-text-tertiary)" }}>↳ </span>
        )}
        {isSubagent && (
          <span
            aria-hidden
            style={{ color: "var(--color-text-secondary)", marginRight: 4 }}
          >
            ▸
          </span>
        )}
        {call.name}
      </div>
      <div style={{ color: "var(--color-text-secondary)" }}>
        {JSON.stringify(call.args)}
      </div>
      {call.result !== undefined && (
        <div style={{ color: "var(--color-text-success)" }}>
          {JSON.stringify(call.result)}
        </div>
      )}
      {call.error && (
        <div style={{ color: "var(--color-text-danger)" }}>{call.error}</div>
      )}
      {children.map((childId) => (
        <ToolCallNode
          key={childId}
          id={childId}
          toolCallsById={toolCallsById}
          childrenByParentId={childrenByParentId}
        />
      ))}
    </div>
  );
}

function WidgetRenderer({ widgetType, props }: { widgetType: string; props: unknown }) {
  if (widgetType === "markdown" && typeof props === "object" && props && "content" in props) {
    return <pre style={widgetBodyStyle}>{String((props as { content: unknown }).content)}</pre>;
  }
  if (widgetType === "table" && isTableProps(props)) {
    return (
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {props.headers.map((header) => (
              <th
                key={header}
                style={{
                  textAlign: "left",
                  borderBottom: "0.5px solid var(--color-border-tertiary)",
                  paddingBottom: 6,
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, cellIndex) => (
                <td key={cellIndex} style={{ paddingTop: 6, color: "var(--color-text-primary)" }}>
                  {String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (widgetType === "json") {
    return <pre style={widgetBodyStyle}>{JSON.stringify(props, null, 2)}</pre>;
  }
  return (
    <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
      Unsupported widget payload
    </div>
  );
}

function InspectorBlock({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section style={{ display: "grid", gap: 8, fontSize: 12 }}>
      <div
        style={{
          color: "var(--color-text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: 1,
          fontSize: 10,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

function isTableProps(
  props: unknown,
): props is { headers: string[]; rows: Array<Array<string | number | boolean>> } {
  return (
    typeof props === "object" &&
    props !== null &&
    Array.isArray((props as { headers?: unknown }).headers) &&
    Array.isArray((props as { rows?: unknown }).rows)
  );
}

const widgetBodyStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontSize: 12,
  color: "var(--color-text-primary)",
};
