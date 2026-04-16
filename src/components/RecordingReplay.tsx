import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { buildRecordingReplayModel, formatBytes } from "../app/recordings";
import { latestToolCall as latestToolCallRecord } from "../app/agentUi";

interface RecordingReplayProps {
  contents: string;
}

export default function RecordingReplay({ contents }: RecordingReplayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const replay = useMemo(() => buildRecordingReplayModel(contents), [contents]);
  const [stepIndex, setStepIndex] = useState(
    replay.playbackSteps.length > 0 ? replay.playbackSteps.length - 1 : 0,
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const currentStep =
    replay.playbackSteps[
      Math.min(stepIndex, Math.max(0, replay.playbackSteps.length - 1))
    ] ?? null;

  useEffect(() => {
    setStepIndex(replay.playbackSteps.length > 0 ? replay.playbackSteps.length - 1 : 0);
    setIsPlaying(false);
  }, [replay.playbackSteps.length]);

  useEffect(() => {
    if (!hostRef.current) return;

    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "Menlo, Monaco, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: "#0b0f16",
        foreground: "#d6d9e0",
      },
    });
    terminal.open(hostRef.current);
    terminalRef.current = terminal;

    return () => terminal.dispose();
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    terminal.reset();

    if (!currentStep) {
      return;
    }

    for (let index = 0; index <= currentStep.lineIndex; index += 1) {
      const line = replay.lines[index];
      if (line?.event?.type === "pty_output") {
        terminal.write(new Uint8Array(line.event.bytes));
      }
    }
  }, [currentStep, replay.lines]);

  useEffect(() => {
    if (!isPlaying || replay.playbackSteps.length === 0) return;
    if (stepIndex >= replay.playbackSteps.length - 1) {
      setIsPlaying(false);
      return;
    }

    const currentTs = replay.playbackSteps[stepIndex]?.tsMs ?? null;
    const nextTs = replay.playbackSteps[stepIndex + 1]?.tsMs ?? currentTs;
    const timer = window.setTimeout(() => {
      setStepIndex((current) => Math.min(current + 1, replay.playbackSteps.length - 1));
    }, playbackDelayMs(currentTs, nextTs));

    return () => window.clearTimeout(timer);
  }, [isPlaying, replay.playbackSteps, stepIndex]);

  const lastIndex = Math.max(0, replay.playbackSteps.length - 1);
  const activeAgentState = currentStep?.agentState ?? replay.agentState;
  const latestToolCall = latestToolCallRecord(activeAgentState);
  const latestFileEdit = activeAgentState.fileEdits[activeAgentState.fileEdits.length - 1] ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 12 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <div
          style={{
            borderRadius: 12,
            border: "1px solid #1d2230",
            background: "#0a0d13",
            padding: 12,
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 12, color: "#7b8498", textTransform: "uppercase", letterSpacing: 1 }}>
                Replay Controls
              </div>
              <div style={{ fontSize: 13, color: "#d6d9e0" }}>
                {currentStep
                  ? `${currentStep.title} · ${formatStepOffset(
                      replay.playbackSteps[0]?.tsMs ?? null,
                      currentStep.tsMs,
                    )}`
                  : "No replayable activity"}
              </div>
              <div style={{ fontSize: 12, color: "#9aa3b7" }}>
                {currentStep?.detail ?? "Open a recording with semantic events or PTY traffic."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <ControlButton
                label="Restart"
                ariaLabel="Restart replay"
                onClick={() => {
                  setIsPlaying(false);
                  setStepIndex(0);
                }}
                disabled={replay.playbackSteps.length === 0}
              />
              <ControlButton
                label="Back"
                ariaLabel="Replay previous step"
                onClick={() => {
                  setIsPlaying(false);
                  setStepIndex((current) => Math.max(0, current - 1));
                }}
                disabled={replay.playbackSteps.length === 0 || stepIndex === 0}
              />
              <ControlButton
                label={isPlaying ? "Pause" : "Play"}
                ariaLabel={isPlaying ? "Pause replay" : "Play replay"}
                onClick={() => {
                  if (replay.playbackSteps.length === 0) return;
                  if (!isPlaying && stepIndex >= lastIndex) {
                    setStepIndex(0);
                  }
                  setIsPlaying((current) => !current);
                }}
                disabled={replay.playbackSteps.length === 0}
              />
              <ControlButton
                label="Next"
                ariaLabel="Replay next step"
                onClick={() => {
                  setIsPlaying(false);
                  setStepIndex((current) => Math.min(lastIndex, current + 1));
                }}
                disabled={replay.playbackSteps.length === 0 || stepIndex >= lastIndex}
              />
            </div>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <input
              aria-label="Replay timeline scrubber"
              type="range"
              min={0}
              max={lastIndex}
              step={1}
              value={Math.min(stepIndex, lastIndex)}
              onChange={(event) => {
                setIsPlaying(false);
                setStepIndex(Number(event.currentTarget.value));
              }}
              disabled={replay.playbackSteps.length === 0}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#7b8498" }}>
              <span>
                step {replay.playbackSteps.length === 0 ? 0 : stepIndex + 1} / {replay.playbackSteps.length}
              </span>
              <span>
                output {formatBytes(currentStep?.outputBytes ?? replay.stats.outputBytes)} · input{" "}
                {formatBytes(currentStep?.inputBytes ?? replay.stats.inputBytes)}
              </span>
            </div>
          </div>
        </div>
        <div
          style={{
            minHeight: 420,
            borderRadius: 12,
            border: "1px solid #1d2230",
            overflow: "hidden",
          }}
        >
          <div ref={hostRef} style={{ height: 420, background: "#0b0f16" }} />
        </div>
      </div>
      <aside
        style={{
          borderRadius: 12,
          border: "1px solid #1d2230",
          background: "#0a0d13",
          padding: 12,
          display: "grid",
          gap: 10,
          overflow: "auto",
        }}
      >
        <div style={{ fontSize: 12, color: "#7b8498", textTransform: "uppercase", letterSpacing: 1 }}>
          Replay Stats
        </div>
        <div style={{ fontSize: 12 }}>events {replay.stats.totalEvents}</div>
        <div style={{ fontSize: 12 }}>
          terminal out {replay.stats.ptyOutputs} · {formatBytes(replay.stats.outputBytes)}
        </div>
        <div style={{ fontSize: 12 }}>
          terminal in {replay.stats.ptyInputs} · {formatBytes(replay.stats.inputBytes)}
        </div>
        <div style={{ fontSize: 12 }}>agent events {replay.stats.agentEvents}</div>
        <div style={{ fontSize: 12 }}>
          approvals requested {replay.stats.approvalRequests}
        </div>
        <div style={{ fontSize: 12 }}>
          approvals resolved {replay.stats.approvalResolutions}
        </div>
        <div style={{ fontSize: 12 }}>resizes {replay.stats.resizeEvents}</div>
        <div style={{ fontSize: 12 }}>duration {formatDuration(replay.stats.durationMs)}</div>
        <div
          style={{
            fontSize: 12,
            color: "#7b8498",
            textTransform: "uppercase",
            letterSpacing: 1,
            marginTop: 8,
          }}
        >
          Step Snapshot
        </div>
        <div style={{ fontSize: 12 }}>
          status {activeAgentState.status ? `${activeAgentState.status.phase}` : "none"}
        </div>
        <div style={{ fontSize: 12 }}>
          progress {activeAgentState.progress ? `${activeAgentState.progress.pct}%` : "none"}
        </div>
        <div style={{ fontSize: 12 }}>
          approvals pending {activeAgentState.pendingApprovals.length}
        </div>
        <div style={{ fontSize: 12 }}>
          latest tool {latestToolCall ? latestToolCall.name : "none"}
        </div>
        <div style={{ fontSize: 12 }}>
          latest file change {latestFileEdit ? `${latestFileEdit.kind} ${latestFileEdit.path}` : "none"}
        </div>
        <div style={{ fontSize: 12 }}>
          finished {activeAgentState.finished ? activeAgentState.finished.summary : "not yet"}
        </div>
        <div style={{ fontSize: 12, color: "#7b8498", textTransform: "uppercase", letterSpacing: 1, marginTop: 8 }}>
          Semantic Timeline
        </div>
        {replay.playbackSteps.slice(-24).map((entry, index) => {
          const isActive = replay.playbackSteps.indexOf(entry) === stepIndex;
          return (
            <button
              type="button"
              key={`${entry.title}-${entry.tsMs ?? index}-${index}`}
              aria-label={`Jump to replay step ${index + 1}`}
              onClick={() => {
                setIsPlaying(false);
                setStepIndex(replay.playbackSteps.indexOf(entry));
              }}
              style={{
                textAlign: "left",
                fontSize: 11,
                color:
                  entry.tone === "warning"
                    ? "#ffcf7d"
                    : entry.tone === "success"
                      ? "#8fdd9f"
                      : "#9aa3b7",
                border: isActive ? "1px solid #5ea1ff" : "1px solid #1d2230",
                borderRadius: 10,
                padding: "8px 9px",
                background: isActive ? "#111827" : "#0c1017",
                display: "grid",
                gap: 4,
                cursor: "pointer",
              }}
            >
              <div style={{ color: "#d6d9e0" }}>
                {formatTimestamp(entry.tsMs)} · {entry.title}
              </div>
              <div>{entry.detail}</div>
            </button>
          );
        })}
      </aside>
    </div>
  );
}

function ControlButton({
  ariaLabel,
  disabled,
  label,
  onClick,
}: {
  ariaLabel: string;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      style={{
        borderRadius: 9,
        border: "1px solid #293042",
        background: disabled ? "#0b0f16" : "#141a24",
        color: disabled ? "#556074" : "#d6d9e0",
        padding: "7px 11px",
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function formatTimestamp(tsMs: number | null) {
  if (typeof tsMs !== "number") {
    return "unknown";
  }
  return new Date(tsMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatStepOffset(startTsMs: number | null, tsMs: number | null) {
  if (typeof startTsMs !== "number" || typeof tsMs !== "number") {
    return "unknown offset";
  }
  const offsetMs = Math.max(0, tsMs - startTsMs);
  if (offsetMs < 1_000) {
    return `+${offsetMs} ms`;
  }
  return `+${(offsetMs / 1_000).toFixed(1)} s`;
}

function playbackDelayMs(currentTsMs: number | null, nextTsMs: number | null) {
  if (typeof currentTsMs !== "number" || typeof nextTsMs !== "number") {
    return 250;
  }
  return Math.min(1_200, Math.max(120, nextTsMs - currentTsMs));
}
