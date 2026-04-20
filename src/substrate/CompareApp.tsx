import { resolvePath } from "./primitives";
import type { SpawnedApp } from "./types";
import { useAppDoc } from "./useAppDoc";

export function CompareApp({
  a,
  b,
  onClose,
}: {
  a: SpawnedApp;
  b: SpawnedApp;
  onClose?: () => void;
}) {
  const docA = useAppDoc(a.id) ?? a.doc;
  const docB = useAppDoc(b.id) ?? b.doc;

  const budgetA = Number(resolvePath(docA, "budget") ?? 0);
  const budgetB = Number(resolvePath(docB, "budget") ?? 0);
  const destA = String(resolvePath(docA, "destination") ?? "");
  const destB = String(resolvePath(docB, "destination") ?? "");
  const actsA =
    ((resolvePath(docA, "activities") as unknown[] | undefined) ?? []).length;
  const actsB =
    ((resolvePath(docB, "activities") as unknown[] | undefined) ?? []).length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0b",
        border: "1px solid #1a1a1c",
        borderRadius: 8,
        minWidth: 320,
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid #1a1a1c",
          fontSize: 11,
          color: "#888",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>
          compare · {a.id.slice(0, 6)} ↔ {b.id.slice(0, 6)}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              padding: "2px 8px",
              background: "#161618",
              color: "#bbb",
              border: "1px solid #262628",
              borderRadius: 3,
              cursor: "pointer",
              fontSize: 10,
            }}
          >
            ×
          </button>
        )}
      </div>
      <div style={{ padding: 12, color: "#ddd", fontSize: 13 }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ color: "#888" }}>
              <th style={th}></th>
              <th style={th}>A</th>
              <th style={th}>B</th>
              <th style={th}>Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={td}>destination</td>
              <td style={td}>{destA}</td>
              <td style={td}>{destB}</td>
              <td style={td}>{destA === destB ? "—" : "≠"}</td>
            </tr>
            <tr>
              <td style={td}>budget</td>
              <td style={td}>${budgetA}</td>
              <td style={td}>${budgetB}</td>
              <td style={td}>
                {budgetA === budgetB
                  ? "—"
                  : `${budgetB - budgetA >= 0 ? "+" : ""}${budgetB - budgetA}`}
              </td>
            </tr>
            <tr>
              <td style={td}>activities</td>
              <td style={td}>{actsA}</td>
              <td style={td}>{actsB}</td>
              <td style={td}>
                {actsA === actsB
                  ? "—"
                  : `${actsB - actsA >= 0 ? "+" : ""}${actsB - actsA}`}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 8px",
  borderBottom: "1px solid #222",
};
const td: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid #141416",
};
