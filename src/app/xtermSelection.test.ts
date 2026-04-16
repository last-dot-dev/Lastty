import xtermPkg from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  readSelectionText,
  readTerminalSelection,
  writeSelectionToClipboard,
  type BufferRange,
  type SelectionBuffer,
  type TerminalSelectionSource,
} from "./xtermSelection";

const { Terminal } = xtermPkg;

describe("readSelectionText", () => {
  it("snaps a selection that starts on the trailing half of a wide character", async () => {
    const buffer = await writeBuffer(["ABCD界EF"]);
    const range = selectionRange(5, 0, 7, 0);

    expect(rawSelectionText(buffer, range)).toBe(" E");
    expect(readSelectionText(buffer, range)).toBe("界E");
  });

  it("keeps wrapped lines joined while preserving wide-character boundaries", async () => {
    const buffer = await writeBuffer(["1234界Z"], { cols: 5, rows: 3 });
    const range = selectionRange(4, 0, 3, 1);

    expect(readSelectionText(buffer, range)).toBe("界Z");
  });
});

describe("readTerminalSelection", () => {
  it("normalizes wide-character boundaries from terminal selection coordinates", async () => {
    const buffer = await writeBuffer(["ABCD界EF"]);

    expect(
      readTerminalSelection(selectionSource(buffer, selectionRange(5, 0, 7, 0))),
    ).toBe("界E");
  });

  it("preserves wrapped lines when terminal selection spans multiple buffer rows", async () => {
    const buffer = await writeBuffer(["1234界Z"], { cols: 5, rows: 3 });

    expect(
      readTerminalSelection(selectionSource(buffer, selectionRange(4, 0, 3, 1))),
    ).toBe("界Z");
  });

  it("reads selections from scrollback history after the viewport scrolls up", async () => {
    const { buffer, term } = await writeTerminal(["aa界x", "bb", "cc", "dd"], {
      cols: 6,
      rows: 2,
      scrollback: 20,
    });

    term.scrollLines(-2);

    expect(term.buffer.active.viewportY).toBe(0);
    expect(
      readTerminalSelection(selectionSource(buffer, selectionRange(3, 0, 5, 0))),
    ).toBe("界x");
  });

  it("normalizes reversed selections that start on a wide-character spacer cell", async () => {
    const { buffer, term } = await writeTerminal(["aa界x", "bb", "cc", "dd"], {
      cols: 6,
      rows: 2,
      scrollback: 20,
    });

    term.scrollLines(-2);

    expect(
      readTerminalSelection(selectionSource(buffer, selectionRange(5, 0, 3, 0))),
    ).toBe("界x");
  });
});

describe("writeSelectionToClipboard", () => {
  it("copies normalized selection text into the clipboard payload", async () => {
    const buffer = await writeBuffer(["ABCD界EF"]);
    const writes: Array<{ format: string; value: string }> = [];
    let prevented = false;

    const copied = writeSelectionToClipboard(
      selectionSource(buffer, selectionRange(5, 0, 7, 0)),
      {
        clipboardData: {
          setData(format, value) {
            writes.push({ format, value });
          },
        },
        preventDefault() {
          prevented = true;
        },
      },
    );

    expect(copied).toBe(true);
    expect(writes).toEqual([{ format: "text/plain", value: "界E" }]);
    expect(prevented).toBe(true);
  });
});

async function writeBuffer(
  lines: string[],
  options: { cols?: number; rows?: number; scrollback?: number } = {},
): Promise<SelectionBuffer> {
  const { buffer } = await writeTerminal(lines, options);
  return buffer;
}

async function writeTerminal(
  lines: string[],
  options: { cols?: number; rows?: number; scrollback?: number } = {},
): Promise<{ buffer: SelectionBuffer; term: InstanceType<typeof Terminal> }> {
  const term = new Terminal({
    allowProposedApi: true,
    cols: options.cols ?? 12,
    rows: options.rows ?? 4,
    scrollback: options.scrollback ?? 1_000,
  });
  term.write(lines.join("\r\n"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    buffer: term.buffer.active as SelectionBuffer,
    term,
  };
}

function rawSelectionText(buffer: SelectionBuffer, range: BufferRange): string {
  const line = buffer.getLine(range.start.line);
  return line?.translateToString(true, range.start.column, range.end.column) ?? "";
}

function selectionRange(
  startColumn: number,
  startLine: number,
  endColumn: number,
  endLine: number,
): BufferRange {
  return {
    start: { column: startColumn, line: startLine },
    end: { column: endColumn, line: endLine },
  };
}

function selectionSource(
  buffer: SelectionBuffer,
  range: BufferRange,
): TerminalSelectionSource {
  return {
    buffer: { active: buffer },
    getSelectionPosition() {
      return {
        start: { x: range.start.column, y: range.start.line },
        end: { x: range.end.column, y: range.end.line },
      };
    },
  };
}
