// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];

    writes: string[] = [];
    resetCount = 0;
    disposed = false;
    host: Element | null = null;

    constructor(_options: unknown) {
      FakeTerminal.instances.push(this);
    }

    open(host: Element) {
      this.host = host;
    }

    write(data: Uint8Array) {
      this.writes.push(new TextDecoder().decode(data));
    }

    reset() {
      this.resetCount += 1;
      this.writes = [];
    }

    dispose() {
      this.disposed = true;
    }
  }

  function reset() {
    FakeTerminal.instances.length = 0;
  }

  return {
    FakeTerminal,
    reset,
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: harness.FakeTerminal,
}));

import RecordingReplay from "./RecordingReplay";

let container: HTMLDivElement;
let root: Root;

describe("RecordingReplay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.reset();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("reconstructs terminal output while scrubbing and playing semantic steps", async () => {
    await act(async () => {
      root.render(<RecordingReplay contents={sampleRecording()} />);
    });

    const terminal = lastTerminal();
    expect(joinWrites(terminal)).toBe("hello world");
    expect(container.textContent).toContain("finished done");

    await act(async () => {
      container
        .querySelector('button[aria-label="Jump to replay step 3"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(joinWrites(terminal)).toBe("hello");
    expect(container.textContent).toContain("status reading");
    expect(container.textContent).toContain("finished not yet");

    await act(async () => {
      container
        .querySelector('button[aria-label="Replay next step"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(joinWrites(terminal)).toBe("hello world");
    expect(container.textContent).toContain("finished not yet");

    const playButton = container.querySelector('button[aria-label="Play replay"]');
    expect(playButton).not.toBeNull();

    await act(async () => {
      playButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(container.textContent).toContain("finished done");
    expect(terminal.resetCount).toBeGreaterThanOrEqual(2);
  });
});

function sampleRecording() {
  return [
    '{"ts_ms":1000,"event":{"type":"session_created","session_id":"abc","agent_id":"codex"}}',
    '{"ts_ms":1100,"event":{"type":"pty_output","session_id":"abc","bytes":[104,101,108,108,111]}}',
    '{"ts_ms":1200,"event":{"type":"agent_status","session_id":"abc","phase":"reading","detail":"Inspecting src"}}',
    '{"ts_ms":1300,"event":{"type":"pty_output","session_id":"abc","bytes":[32,119,111,114,108,100]}}',
    '{"ts_ms":1400,"event":{"type":"agent_finished","session_id":"abc","summary":"done","exit_code":0}}',
  ].join("\n");
}

function lastTerminal() {
  const terminal = harness.FakeTerminal.instances.at(-1);
  if (!terminal) {
    throw new Error("expected a fake terminal instance");
  }
  return terminal;
}

function joinWrites(terminal: InstanceType<typeof harness.FakeTerminal>) {
  return terminal.writes.join("");
}
