import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open as openFolderDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import type { RecentProject } from "../app/recentProjects";
import {
  basename,
  isValidCloneUrl,
  parentPath,
  previewRepoName,
} from "./NewViewWelcome.logic";

type Mode = "choose" | "cloneForm" | "cloning";

export interface NewViewWelcomeProps {
  recents: RecentProject[];
  onSubmit: (projectRoot: string, viewName?: string) => Promise<void> | void;
  onClone: (
    url: string,
    parentDir: string,
  ) => Promise<{ path: string; repo_name: string }>;
  onCreateProject: (path: string) => Promise<string>;
  onRecentMissing?: (path: string) => void;
}

const MAX_RECENTS_SHOWN = 5;

export default function NewViewWelcome({
  recents,
  onSubmit,
  onClone,
  onCreateProject,
  onRecentMissing,
}: NewViewWelcomeProps) {
  const [mode, setMode] = useState<Mode>("choose");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneParent, setCloneParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (mode === "cloneForm") {
      urlInputRef.current?.focus();
    }
  }, [mode]);

  async function handleOpenFolder() {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open folder as new view",
    }).catch(() => null);
    if (typeof picked === "string" && picked.length > 0) {
      await onSubmit(picked);
    }
  }

  async function handlePickCloneParent() {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Pick parent directory for clone",
    }).catch(() => null);
    if (typeof picked === "string" && picked.length > 0) {
      setCloneParent(picked);
      setError(null);
    }
  }

  async function handleRecentClick(entry: RecentProject) {
    try {
      await onSubmit(entry.path);
    } catch {
      onRecentMissing?.(entry.path);
    }
  }

  async function handleStartClone() {
    const url = cloneUrl.trim();
    if (!isValidCloneUrl(url)) {
      setError("Enter a valid https://, ssh://, git://, or git@host:path URL.");
      return;
    }
    if (!cloneParent) {
      setError("Pick a parent directory to clone into.");
      return;
    }
    setMode("cloning");
    setError(null);
    try {
      const result = await onClone(url, cloneParent);
      await onSubmit(result.path, result.repo_name);
    } catch (err) {
      setError(String(err));
      setMode("cloneForm");
    }
  }

  async function handleNewProject() {
    setError(null);
    const picked = await saveDialog({
      title: "New project",
      defaultPath: "new-project",
    }).catch(() => null);
    if (typeof picked !== "string" || picked.length === 0) return;
    try {
      const path = await onCreateProject(picked);
      await onSubmit(path, basename(path));
    } catch (err) {
      setError(String(err));
    }
  }

  const shownRecents = recents.slice(0, MAX_RECENTS_SHOWN);
  const previewName = previewRepoName(cloneUrl);

  return (
    <div style={containerStyle}>
      <div style={panelStyle} aria-labelledby="new-view-welcome-title">
        <div style={titleStyle} id="new-view-welcome-title">
          New view
        </div>

        {mode === "choose" && (
          <>
            <div style={sectionLabelStyle}>Start</div>
            <button type="button" style={primaryButtonStyle} onClick={handleOpenFolder}>
              Open folder…
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => void handleNewProject()}
            >
              New project…
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => {
                setMode("cloneForm");
                setError(null);
              }}
            >
              Clone git repository…
            </button>

            {error && <div style={errorStyle}>{error}</div>}

            {shownRecents.length > 0 && (
              <>
                <div style={{ ...sectionLabelStyle, marginTop: 14 }}>Recent</div>
                <div style={recentListStyle}>
                  {shownRecents.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      style={recentRowStyle}
                      onClick={() => void handleRecentClick(entry)}
                      title={entry.path}
                    >
                      <span style={recentNameStyle}>{basename(entry.path) || entry.path}</span>
                      <span style={recentPathStyle}>{parentPath(entry.path)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {mode === "cloneForm" && (
          <>
            <div style={sectionLabelStyle}>Clone git repository</div>
            <input
              ref={urlInputRef}
              type="text"
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.target.value)}
              placeholder="https://github.com/owner/repo"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              style={inputStyle}
            />
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => void handlePickCloneParent()}
            >
              {cloneParent ? `Parent: ${cloneParent}` : "Choose parent directory…"}
            </button>
            {previewName && cloneParent && (
              <div style={hintStyle}>Will clone into {cloneParent}/{previewName}</div>
            )}
            {error && <div style={errorStyle}>{error}</div>}
            <div style={buttonRowStyle}>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => {
                  setMode("choose");
                  setError(null);
                }}
              >
                Back
              </button>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => void handleStartClone()}
                disabled={!cloneUrl.trim() || !cloneParent}
              >
                Clone
              </button>
            </div>
          </>
        )}

        {mode === "cloning" && (
          <>
            <div style={sectionLabelStyle}>Cloning…</div>
            <div style={hintStyle}>
              Cloning {previewName || cloneUrl}. This may take a minute for large repositories.
            </div>
          </>
        )}

      </div>
    </div>
  );
}

const containerStyle: CSSProperties = {
  flex: 1,
  display: "grid",
  placeItems: "center",
  padding: 24,
  overflow: "auto",
};

const panelStyle: CSSProperties = {
  background: "transparent",
  color: "var(--color-text-primary)",
  padding: 0,
  width: 460,
  maxWidth: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 10,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-secondary)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  marginTop: 4,
};

const primaryButtonStyle: CSSProperties = {
  borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-secondary)",
  background: "var(--color-background-primary)",
  color: "var(--color-text-primary)",
  padding: "8px 12px",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
  fontSize: 12,
};

const secondaryButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  background: "transparent",
};

const recentListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 180,
  overflow: "auto",
};

const recentRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 10,
  borderRadius: "var(--border-radius-sm, 4px)",
  border: "0.5px solid transparent",
  background: "transparent",
  color: "var(--color-text-primary)",
  padding: "6px 8px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  textAlign: "left",
};

const recentNameStyle: CSSProperties = {
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const recentPathStyle: CSSProperties = {
  color: "var(--color-text-secondary)",
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  direction: "rtl",
  textAlign: "left",
};

const inputStyle: CSSProperties = {
  borderRadius: "var(--border-radius-md)",
  border: "0.5px solid var(--color-border-secondary)",
  background: "var(--color-background-primary)",
  color: "var(--color-text-primary)",
  padding: "8px 10px",
  fontFamily: "inherit",
  fontSize: 12,
  outline: "none",
};

const hintStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-secondary)",
};

const errorStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-warning, #e08383)",
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 6,
};
